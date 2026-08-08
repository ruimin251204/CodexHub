use crate::*;

const PROCESS_LIMIT: usize = 128;

#[derive(Clone, Debug)]
pub(crate) enum RemoteCodexProcessGate {
    Bypass,
    ExpectClear,
    Terminate(Vec<RemoteCodexProcessIdentity>),
    ForceTerminate(Vec<RemoteCodexProcessIdentity>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RemoteCodexProcessGateResult {
    pub(crate) targeted: usize,
    pub(crate) stopped: usize,
    pub(crate) message: String,
}

pub(crate) fn inspect_remote_codex_processes(
    alias: &str,
    timeout_ms: u64,
) -> RemoteCodexProcessPreflightItem {
    let script = remote_codex_process_preflight_script();
    let output = ssh::run_ssh_script(alias, &script, timeout_ms).unwrap_or_else(|error| {
        ssh::SshCommandOutput {
            command: format!("ssh {alias} inspect remote Codex processes"),
            stdout: String::new(),
            stderr: format!("Could not inspect remote Codex processes: {error}"),
            exit_code: None,
            duration_ms: 0,
            timed_out: false,
        }
    });
    match parse_remote_codex_process_preflight(&output.stdout) {
        Ok(processes) if output.success() => {
            let message = if processes.is_empty() {
                "No running process references a managed standalone Codex release.".into()
            } else {
                format!(
                    "{} running process(es) reference managed standalone Codex releases.",
                    processes.len()
                )
            };
            RemoteCodexProcessPreflightItem {
                host_alias: alias.into(),
                ok: true,
                processes,
                message,
            }
        }
        Ok(_) | Err(_) => RemoteCodexProcessPreflightItem {
            host_alias: alias.into(),
            ok: false,
            processes: Vec::new(),
            message: preflight_failure_message(&output),
        },
    }
}

pub(crate) fn enforce_remote_codex_process_gate(
    alias: &str,
    gate: &RemoteCodexProcessGate,
    timeout_ms: u64,
) -> Result<RemoteCodexProcessGateResult, String> {
    match gate {
        RemoteCodexProcessGate::Bypass => Ok(RemoteCodexProcessGateResult {
            targeted: 0,
            stopped: 0,
            message: "Process-impact gating was not requested for this single-host operation."
                .into(),
        }),
        RemoteCodexProcessGate::ExpectClear => {
            let inspected = inspect_remote_codex_processes(alias, timeout_ms);
            if !inspected.ok {
                return Err(inspected.message);
            }
            if !inspected.processes.is_empty() {
                return Err(format!(
                    "Process impact changed after preview; {} unapproved process(es) are now using a managed Codex release. Retry the batch update.",
                    inspected.processes.len()
                ));
            }
            Ok(RemoteCodexProcessGateResult {
                targeted: 0,
                stopped: 0,
                message: "No running managed-release process requires termination.".into(),
            })
        }
        RemoteCodexProcessGate::Terminate(processes)
        | RemoteCodexProcessGate::ForceTerminate(processes) => {
            let force = matches!(gate, RemoteCodexProcessGate::ForceTerminate(_));
            validate_approved_processes(processes)?;
            let script = remote_codex_process_termination_script(processes, force);
            let output =
                ssh::run_ssh_script(alias, &script, timeout_ms.max(30_000)).map_err(|error| {
                    format!("Could not terminate approved Codex processes: {error}")
                })?;
            let result = parse_remote_codex_process_termination(&output, force)?;
            if result.targeted != processes.len() {
                return Err(
                    "Remote process termination returned an inconsistent approval count.".into(),
                );
            }
            Ok(result)
        }
    }
}

fn preflight_failure_message(output: &ssh::SshCommandOutput) -> String {
    let reason = marker_value(&output.stdout, "CODEXHUB_PROCESS_PREFLIGHT_REASON")
        .filter(|value| safe_reason(value))
        .unwrap_or_else(|| {
            if output.timed_out {
                "timeout".into()
            } else {
                "identity-unavailable".into()
            }
        });
    format!(
        "Running Codex processes could not be verified safely ({reason}). Exit related processes and retry."
    )
}

fn parse_remote_codex_process_preflight(
    stdout: &str,
) -> Result<Vec<RemoteCodexProcessIdentity>, String> {
    if marker_value(stdout, "CODEXHUB_PROCESS_PREFLIGHT_STATUS").as_deref() != Some("ready") {
        return Err("Remote process preflight did not complete safely.".into());
    }
    let expected = marker_value(stdout, "CODEXHUB_PROCESS_PREFLIGHT_COUNT")
        .ok_or_else(|| "Remote process preflight did not return a count.".to_string())?
        .parse::<usize>()
        .map_err(|_| "Remote process preflight returned an invalid count.".to_string())?;
    if expected > PROCESS_LIMIT {
        return Err("Remote process preflight exceeded the process limit.".into());
    }
    let mut processes = Vec::new();
    for line in stdout.lines() {
        let Some(value) = line.strip_prefix("CODEXHUB_PROCESS=") else {
            continue;
        };
        let fields = value.split('\t').collect::<Vec<_>>();
        if fields.len() != 6 {
            return Err("Remote process preflight returned a malformed process row.".into());
        }
        let pid = fields[0]
            .parse::<u32>()
            .map_err(|_| "Remote process preflight returned an invalid PID.".to_string())?;
        if pid == 0 || fields[1].is_empty() || !fields[1].bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err("Remote process preflight returned an invalid identity.".into());
        }
        let process_name = decode_hex(fields[2])?;
        let process_kind = match fields[3] {
            "app-server" => RemoteCodexProcessKind::AppServer,
            "app-server-proxy" => RemoteCodexProcessKind::AppServerProxy,
            "codex-session" => RemoteCodexProcessKind::CodexSession,
            "unknown" => RemoteCodexProcessKind::Unknown,
            _ => return Err("Remote process preflight returned an invalid process kind.".into()),
        };
        let version = decode_hex(fields[4])?;
        let release_path = decode_hex(fields[5])?;
        if process_name.is_empty()
            || process_name.len() > 128
            || process_name.contains(['\n', '\r', '\t'])
            || version.is_empty()
            || version.len() > 128
            || release_path.is_empty()
            || release_path.len() > 4096
            || release_path.contains(['\n', '\r', '\t'])
        {
            return Err("Remote process preflight returned unsafe process metadata.".into());
        }
        processes.push(RemoteCodexProcessIdentity {
            pid,
            start_time: fields[1].into(),
            process_name,
            process_kind,
            version,
            release_path,
        });
    }
    if processes.len() != expected {
        return Err("Remote process preflight returned an inconsistent count.".into());
    }
    processes.sort_by_key(|process| process.pid);
    if processes.windows(2).any(|pair| pair[0].pid == pair[1].pid) {
        return Err("Remote process preflight returned duplicate PIDs.".into());
    }
    Ok(processes)
}

fn validate_approved_processes(processes: &[RemoteCodexProcessIdentity]) -> Result<(), String> {
    if processes.is_empty() || processes.len() > PROCESS_LIMIT {
        return Err("Approved process selection is empty or exceeds the safety limit.".into());
    }
    let mut pids = std::collections::HashSet::new();
    for process in processes {
        if process.pid == 0
            || !pids.insert(process.pid)
            || process.start_time.is_empty()
            || !process.start_time.bytes().all(|byte| byte.is_ascii_digit())
            || process.process_name.is_empty()
            || process.process_name.contains(['\n', '\r', '\t'])
            || process.process_kind == RemoteCodexProcessKind::Unknown
            || process.release_path.is_empty()
            || process.release_path.contains(['\n', '\r', '\t'])
        {
            return Err("Approved process identity is invalid.".into());
        }
    }
    Ok(())
}

fn parse_remote_codex_process_termination(
    output: &ssh::SshCommandOutput,
    force: bool,
) -> Result<RemoteCodexProcessGateResult, String> {
    let status = marker_value(&output.stdout, "CODEXHUB_PROCESS_TERMINATION_STATUS")
        .unwrap_or_else(|| "failed".into());
    let reason = marker_value(&output.stdout, "CODEXHUB_PROCESS_TERMINATION_REASON")
        .filter(|value| safe_reason(value))
        .unwrap_or_else(|| "identity-unavailable".into());
    let targeted = marker_usize(&output.stdout, "CODEXHUB_PROCESS_TERMINATION_TARGETED")?;
    let stopped = marker_usize(&output.stdout, "CODEXHUB_PROCESS_TERMINATION_STOPPED")?;
    let forced = marker_usize(&output.stdout, "CODEXHUB_PROCESS_TERMINATION_FORCED")?;
    if status != "stopped" || !output.success() || stopped > targeted || (!force && forced != 0) {
        return Err(format!(
            "Approved Codex processes were not safely stopped ({reason}); installation/update was not started."
        ));
    }
    Ok(RemoteCodexProcessGateResult {
        targeted,
        stopped,
        message: if force {
            format!(
                "Force-cleared {stopped}/{targeted} approved Codex process(es); SIGKILL was required {forced} time(s) for stubborn or restarted processes."
            )
        } else {
            format!("Stopped {stopped}/{targeted} approved Codex process(es) with SIGTERM.")
        },
    })
}

fn marker_usize(stdout: &str, marker: &str) -> Result<usize, String> {
    marker_value(stdout, marker)
        .ok_or_else(|| format!("Remote process termination did not return {marker}."))?
        .parse::<usize>()
        .map_err(|_| format!("Remote process termination returned invalid {marker}."))
}

fn marker_value(stdout: &str, marker: &str) -> Option<String> {
    let prefix = format!("{marker}=");
    stdout
        .lines()
        .rev()
        .find_map(|line| line.strip_prefix(&prefix).map(str::trim))
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn safe_reason(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn decode_hex(value: &str) -> Result<String, String> {
    if value.is_empty()
        || value.len() % 2 != 0
        || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Remote process preflight returned invalid hexadecimal metadata.".into());
    }
    let bytes = value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let text = std::str::from_utf8(pair).map_err(|_| "Invalid hexadecimal metadata.")?;
            u8::from_str_radix(text, 16).map_err(|_| "Invalid hexadecimal metadata.")
        })
        .collect::<Result<Vec<_>, _>>()?;
    String::from_utf8(bytes).map_err(|_| "Remote process metadata was not UTF-8.".into())
}

fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn remote_codex_process_termination_script(
    processes: &[RemoteCodexProcessIdentity],
    force: bool,
) -> String {
    let approved_rows = processes
        .iter()
        .map(|process| {
            format!(
                "printf '%s\\t%s\\t%s\\t%s\\t%s\\n' {} {} {} {} {} >>\"$approved_file\"\n",
                shell_single_quote(&process.pid.to_string()),
                shell_single_quote(&process.start_time),
                shell_single_quote(&process.release_path),
                shell_single_quote(&process.process_name),
                shell_single_quote(process_kind_wire_value(&process.process_kind)),
            )
        })
        .collect::<String>();
    complete_termination_template(force).replace("__APPROVED_ROWS__", &approved_rows)
}

fn process_kind_wire_value(kind: &RemoteCodexProcessKind) -> &'static str {
    match kind {
        RemoteCodexProcessKind::AppServer => "app-server",
        RemoteCodexProcessKind::AppServerProxy => "app-server-proxy",
        RemoteCodexProcessKind::CodexSession => "codex-session",
        RemoteCodexProcessKind::Unknown => "unknown",
    }
}

const PROCESS_DISCOVERY_FUNCTIONS: &str = r#"
read_uid_start() {
  identity_dir=$1
  observed_uid=$(awk '/^Uid:/ { count += 1; if (count == 1) value=$2 } END { if (count != 1 || value !~ /^[0-9]+$/) exit 2; print value }' "$identity_dir/status" 2>/dev/null) || return 2
  observed_start=$(sed 's/^[^)]*) //' "$identity_dir/stat" 2>/dev/null | awk '{ if ($20 !~ /^[0-9]+$/) exit 2; print $20 }') || return 2
  [ -n "$observed_start" ] || return 2
}

find_managed_release() {
  match_dir=$1
  matched_release=""
  match_exe=$(readlink -f "$match_dir/exe" 2>/dev/null || true)
  for release_dir in "$release_root_real"/*; do
    [ -d "$release_dir" ] && [ ! -L "$release_dir" ] || continue
    release_real=$(readlink -f "$release_dir" 2>/dev/null || true)
    [ -n "$release_real" ] || return 2
    [ "${release_real%/*}" = "$release_root_real" ] || return 2
    case "$match_exe" in "$release_real"/*) matched_release=$release_real; return 0 ;; esac
    if [ -r "$match_dir/maps" ] && grep -F " $release_real/" "$match_dir/maps" >/dev/null 2>&1; then
      matched_release=$release_real
      return 0
    fi
  done
  return 1
}

classify_cmdline_hex() {
  cmdline_hex=$1
  managed_kind=unknown
  case "$cmdline_hex" in
    *006170702d7365727665720070726f787900) managed_kind=app-server-proxy ;;
    *006170702d736572766572002d2d6c697374656e00*) managed_kind=app-server ;;
    ?*) managed_kind=codex-session ;;
  esac
}

read_managed_process() {
  candidate_dir=$1
  candidate_pid=${candidate_dir##*/}
  case "$candidate_pid" in ''|*[!0-9]*) return 2 ;; esac
  [ -r "$candidate_dir/status" ] && [ -r "$candidate_dir/stat" ] && [ -r "$candidate_dir/comm" ] || return 1
  read_uid_start "$candidate_dir" || return 2
  first_uid=$observed_uid
  first_start=$observed_start
  [ "$first_uid" = "$current_uid" ] || return 1
  candidate_comm=$(sed -n '1p' "$candidate_dir/comm" 2>/dev/null || true)
  [ -n "$candidate_comm" ] || return 2
  find_managed_release "$candidate_dir"
  release_status=$?
  case "$release_status" in
    0) first_release=$matched_release ;;
    1)
      case "$candidate_comm" in codex|codex-*) [ -r "$candidate_dir/exe" ] || return 2 ;; esac
      return 1
      ;;
    *) return 2 ;;
  esac
  read_uid_start "$candidate_dir" || return 2
  [ "$observed_uid" = "$first_uid" ] && [ "$observed_start" = "$first_start" ] || return 2
  candidate_comm_after=$(sed -n '1p' "$candidate_dir/comm" 2>/dev/null || true)
  [ "$candidate_comm_after" = "$candidate_comm" ] || return 2
  find_managed_release "$candidate_dir" || return 2
  [ "$matched_release" = "$first_release" ] || return 2
  # Classification exposes only a bounded label; raw argv never leaves the host.
  managed_kind=unknown
  if [ -r "$candidate_dir/cmdline" ]; then
    cmdline_hex=$(od -An -v -tx1 "$candidate_dir/cmdline" 2>/dev/null | tr -d '[:space:]' || true)
    classify_cmdline_hex "$cmdline_hex"
  fi
  managed_pid=$candidate_pid
  managed_start=$first_start
  managed_comm=$candidate_comm
  managed_release=$first_release
  return 0
}

scan_managed_processes() {
  destination=$1
  : >"$destination" || return 2
  for candidate_dir in "$proc_root"/[0-9]*; do
    [ -d "$candidate_dir" ] || continue
    read_managed_process "$candidate_dir"
    candidate_status=$?
    case "$candidate_status" in
      0) printf '%s\t%s\t%s\t%s\t%s\n' "$managed_pid" "$managed_start" "$managed_release" "$managed_comm" "$managed_kind" >>"$destination" || return 2 ;;
      1) ;;
      *) return 2 ;;
    esac
  done
  return 0
}
"#;

const REMOTE_CODEX_PROCESS_PREFLIGHT_SCRIPT: &str = r#"set -u
umask 077
proc_root=${CODEXHUB_PROC_ROOT:-/proc}
release_root=${CODEXHUB_RELEASE_ROOT:-$HOME/.codex/packages/standalone/releases}
count=0
emit_result() {
  printf 'CODEXHUB_PROCESS_PREFLIGHT_STATUS=%s\n' "$1"
  printf 'CODEXHUB_PROCESS_PREFLIGHT_COUNT=%s\n' "$count"
  printf 'CODEXHUB_PROCESS_PREFLIGHT_REASON=%s\n' "$2"
}
for tool in id awk sed readlink grep od tr; do
  command -v "$tool" >/dev/null 2>&1 || { emit_result failed required-tool-unavailable; exit 4; }
done
[ -d "$proc_root" ] || { emit_result failed proc-unavailable; exit 4; }
current_uid=$(id -u 2>/dev/null) || { emit_result failed uid-unavailable; exit 4; }
if [ ! -d "$release_root" ]; then
  emit_result ready no-managed-releases
  exit 0
fi
release_root_real=$(readlink -f "$release_root" 2>/dev/null || true)
[ -n "$release_root_real" ] && [ -d "$release_root_real" ] && [ ! -L "$release_root_real" ] || { emit_result failed release-root-identity-unknown; exit 4; }
"#;

const REMOTE_CODEX_PROCESS_PREFLIGHT_TAIL: &str = r#"
for candidate_dir in "$proc_root"/[0-9]*; do
  [ -d "$candidate_dir" ] || continue
  read_managed_process "$candidate_dir"
  candidate_status=$?
  case "$candidate_status" in
    0)
      count=$((count + 1))
      [ "$count" -le 128 ] || { emit_result failed process-limit-exceeded; exit 4; }
      comm_hex=$(printf '%s' "$managed_comm" | od -An -v -tx1 | tr -d '[:space:]') || { emit_result failed process-name-unavailable; exit 4; }
      version=${managed_release##*/}
      version_hex=$(printf '%s' "$version" | od -An -v -tx1 | tr -d '[:space:]') || { emit_result failed version-unavailable; exit 4; }
      release_hex=$(printf '%s' "$managed_release" | od -An -v -tx1 | tr -d '[:space:]') || { emit_result failed release-path-unavailable; exit 4; }
      printf 'CODEXHUB_PROCESS=%s\t%s\t%s\t%s\t%s\t%s\n' "$managed_pid" "$managed_start" "$comm_hex" "$managed_kind" "$version_hex" "$release_hex"
      ;;
    1) ;;
    *) emit_result failed process-identity-unknown; exit 4 ;;
  esac
done
emit_result ready scan-complete
"#;

const REMOTE_CODEX_PROCESS_TERMINATION_TEMPLATE: &str = r#"set -u
umask 077
proc_root=${CODEXHUB_PROC_ROOT:-/proc}
release_root=${CODEXHUB_RELEASE_ROOT:-$HOME/.codex/packages/standalone/releases}
work_dir="${TMPDIR:-/tmp}/codexhub-process-stop.$$"
approved_file="$work_dir/approved"
current_file="$work_dir/current"
second_file="$work_dir/second"
targeted=0
stopped=0
forced=0
emit_result() {
  printf 'CODEXHUB_PROCESS_TERMINATION_STATUS=%s\n' "$1"
  printf 'CODEXHUB_PROCESS_TERMINATION_TARGETED=%s\n' "$targeted"
  printf 'CODEXHUB_PROCESS_TERMINATION_STOPPED=%s\n' "$stopped"
  printf 'CODEXHUB_PROCESS_TERMINATION_FORCED=%s\n' "$forced"
  printf 'CODEXHUB_PROCESS_TERMINATION_REASON=%s\n' "$2"
}
cleanup() { rm -f "$approved_file" "$current_file" "$second_file"; rmdir "$work_dir" 2>/dev/null || true; }
trap cleanup EXIT HUP INT TERM
for tool in id awk sed readlink grep kill sleep od tr; do
  command -v "$tool" >/dev/null 2>&1 || { emit_result failed required-tool-unavailable; exit 4; }
done
[ -d "$proc_root" ] || { emit_result failed proc-unavailable; exit 4; }
current_uid=$(id -u 2>/dev/null) || { emit_result failed uid-unavailable; exit 4; }
[ -d "$release_root" ] || { emit_result failed managed-release-missing; exit 4; }
release_root_real=$(readlink -f "$release_root" 2>/dev/null || true)
[ -n "$release_root_real" ] && [ -d "$release_root_real" ] && [ ! -L "$release_root_real" ] || { emit_result failed release-root-identity-unknown; exit 4; }
mkdir "$work_dir" 2>/dev/null || { emit_result failed work-dir-unavailable; exit 4; }
: >"$approved_file" || { emit_result failed work-file-unavailable; exit 4; }
__APPROVED_ROWS__
"#;

const REMOTE_CODEX_PROCESS_TERMINATION_TAIL: &str = r#"
targeted=$(awk 'END { print NR + 0 }' "$approved_file" 2>/dev/null) || { emit_result failed approval-unavailable; exit 4; }
[ "$targeted" -gt 0 ] && [ "$targeted" -le 128 ] || { emit_result failed approval-invalid; exit 4; }
scan_managed_processes "$current_file" || { emit_result failed process-identity-unknown; exit 4; }
tab_character=$(printf '\t')
while IFS="$tab_character" read -r pid start release comm kind; do
  grep -F -x "$pid$tab_character$start$tab_character$release$tab_character$comm$tab_character$kind" "$approved_file" >/dev/null 2>&1 || { emit_result failed process-impact-changed; exit 4; }
done <"$current_file"
scan_managed_processes "$second_file" || { emit_result failed process-identity-unknown; exit 4; }
while IFS= read -r row; do grep -F -x "$row" "$second_file" >/dev/null 2>&1 || { emit_result failed process-impact-changed; exit 4; }; done <"$current_file"
while IFS= read -r row; do grep -F -x "$row" "$current_file" >/dev/null 2>&1 || { emit_result failed process-impact-changed; exit 4; }; done <"$second_file"
while IFS="$tab_character" read -r pid start release comm kind; do
  [ -n "$pid" ] || continue
  read_managed_process "$proc_root/$pid" || { emit_result failed process-impact-changed; exit 4; }
  [ "$managed_start" = "$start" ] && [ "$managed_release" = "$release" ] && [ "$managed_comm" = "$comm" ] && [ "$managed_kind" = "$kind" ] && [ "$kind" != unknown ] || { emit_result failed process-impact-changed; exit 4; }
  kill -TERM "$pid" 2>/dev/null || { emit_result failed term-failed; exit 4; }
done <"$second_file"
elapsed=0
while [ "$elapsed" -lt 5 ]; do
  scan_managed_processes "$current_file" || { emit_result failed process-identity-unknown; exit 4; }
  remaining=$(awk 'END { print NR + 0 }' "$current_file" 2>/dev/null) || { emit_result failed process-count-unavailable; exit 4; }
  [ "$remaining" -eq 0 ] && break
  sleep 1
  elapsed=$((elapsed + 1))
done
scan_managed_processes "$current_file" || { emit_result failed process-identity-unknown; exit 4; }
remaining=$(awk 'END { print NR + 0 }' "$current_file" 2>/dev/null) || { emit_result failed process-count-unavailable; exit 4; }
[ "$remaining" -eq 0 ] || { emit_result failed old-process-still-running; exit 4; }
stopped=$(awk 'END { print NR + 0 }' "$second_file" 2>/dev/null) || { emit_result failed process-count-unavailable; exit 4; }
emit_result stopped completed
"#;

const REMOTE_CODEX_PROCESS_FORCE_TERMINATION_TAIL: &str = r#"
targeted=$(awk 'END { print NR + 0 }' "$approved_file" 2>/dev/null) || { emit_result failed approval-unavailable; exit 4; }
[ "$targeted" -gt 0 ] && [ "$targeted" -le 128 ] || { emit_result failed approval-invalid; exit 4; }

# Explicit Update authorization permits exact-PID escalation only inside approved releases.
approved_release_contains() {
  wanted_release=$1
  while IFS="$(printf '\t')" read -r approved_pid approved_start approved_release approved_comm approved_kind; do
    [ "$approved_release" = "$wanted_release" ] && return 0
  done <"$approved_file"
  return 1
}

validate_force_snapshot() {
  snapshot_file=$1
  snapshot_count=0
  while IFS="$(printf '\t')" read -r pid start release comm kind; do
    [ -n "$pid" ] || continue
    [ "$kind" != unknown ] || return 2
    approved_release_contains "$release" || return 3
    snapshot_count=$((snapshot_count + 1))
    [ "$snapshot_count" -le 128 ] || return 2
  done <"$snapshot_file"
  return 0
}

snapshots_match() {
  left_file=$1
  right_file=$2
  while IFS= read -r row; do grep -F -x "$row" "$right_file" >/dev/null 2>&1 || return 1; done <"$left_file"
  while IFS= read -r row; do grep -F -x "$row" "$left_file" >/dev/null 2>&1 || return 1; done <"$right_file"
  return 0
}

stable_force_scan() {
  scan_managed_processes "$current_file" || return 2
  scan_managed_processes "$second_file" || return 2
  snapshots_match "$current_file" "$second_file" || return 4
  validate_force_snapshot "$second_file"
}

term_force_snapshot() {
  while IFS="$(printf '\t')" read -r pid start release comm kind; do
    [ -n "$pid" ] || continue
    read_managed_process "$proc_root/$pid"
    identity_status=$?
    case "$identity_status" in
      0)
        [ "$managed_start" = "$start" ] && [ "$managed_release" = "$release" ] && [ "$managed_comm" = "$comm" ] && [ "$managed_kind" = "$kind" ] && [ "$kind" != unknown ] || continue
        kill -TERM "$pid" 2>/dev/null || { [ ! -d "$proc_root/$pid" ] || return 2; }
        ;;
      1) ;;
      *) return 2 ;;
    esac
  done <"$second_file"
  return 0
}

kill_force_snapshot() {
  while IFS="$(printf '\t')" read -r pid start release comm kind; do
    [ -n "$pid" ] || continue
    read_managed_process "$proc_root/$pid"
    identity_status=$?
    case "$identity_status" in
      0)
        [ "$managed_start" = "$start" ] && [ "$managed_release" = "$release" ] && [ "$managed_comm" = "$comm" ] && [ "$managed_kind" = "$kind" ] && [ "$kind" != unknown ] || continue
        kill -KILL "$pid" 2>/dev/null || { [ ! -d "$proc_root/$pid" ] || return 2; }
        forced=$((forced + 1))
        ;;
      1) ;;
      *) return 2 ;;
    esac
  done <"$second_file"
  return 0
}

cycles=0
empty_checks=0
# Require two stable empty observations so an App-triggered replacement cannot race installation.
while [ "$cycles" -lt 6 ]; do
  stable_force_scan
  scan_status=$?
  case "$scan_status" in
    0) ;;
    3) emit_result failed process-outside-approved-release; exit 4 ;;
    4) sleep 1; cycles=$((cycles + 1)); continue ;;
    *) emit_result failed process-identity-unknown; exit 4 ;;
  esac
  if [ "$snapshot_count" -eq 0 ]; then
    empty_checks=$((empty_checks + 1))
    [ "$empty_checks" -ge 2 ] && { stopped=$targeted; emit_result stopped force-completed; exit 0; }
    sleep 1
    continue
  fi
  empty_checks=0
  term_force_snapshot || { emit_result failed term-failed; exit 4; }
  sleep 1
  stable_force_scan
  scan_status=$?
  case "$scan_status" in
    0) ;;
    3) emit_result failed process-outside-approved-release; exit 4 ;;
    4) cycles=$((cycles + 1)); continue ;;
    *) emit_result failed process-identity-unknown; exit 4 ;;
  esac
  if [ "$snapshot_count" -gt 0 ]; then
    kill_force_snapshot || { emit_result failed kill-failed; exit 4; }
    sleep 1
  fi
  cycles=$((cycles + 1))
done
emit_result failed force-stop-respawn-limit
exit 4
"#;

fn complete_preflight_script() -> String {
    format!(
        "{REMOTE_CODEX_PROCESS_PREFLIGHT_SCRIPT}{PROCESS_DISCOVERY_FUNCTIONS}{REMOTE_CODEX_PROCESS_PREFLIGHT_TAIL}"
    )
}

fn complete_termination_template(force: bool) -> String {
    let tail = if force {
        REMOTE_CODEX_PROCESS_FORCE_TERMINATION_TAIL
    } else {
        REMOTE_CODEX_PROCESS_TERMINATION_TAIL
    };
    format!("{REMOTE_CODEX_PROCESS_TERMINATION_TEMPLATE}{PROCESS_DISCOVERY_FUNCTIONS}{tail}")
}

// Keep the exported constants small while assembling shared process-discovery code once.
pub(crate) fn remote_codex_process_preflight_script() -> String {
    complete_preflight_script()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::process::{Command, Stdio};

    #[cfg(unix)]
    fn write_fake_process(
        proc_root: &std::path::Path,
        release_binary: &std::path::Path,
        pid: u32,
        start_time: &str,
    ) {
        use std::os::unix::fs::{symlink, MetadataExt};

        let process_dir = proc_root.join(pid.to_string());
        std::fs::create_dir_all(&process_dir).expect("fake process directory");
        let uid = std::fs::metadata(proc_root).expect("proc metadata").uid();
        std::fs::write(
            process_dir.join("status"),
            format!("Name:\tcodex\nUid:\t{uid}\t{uid}\t{uid}\t{uid}\n"),
        )
        .expect("fake status");
        // Linux stat field 22 is the start time; after removing pid/comm it is awk field 20.
        std::fs::write(
            process_dir.join("stat"),
            format!("{pid} (codex) S {} {start_time}\n", vec!["0"; 18].join(" ")),
        )
        .expect("fake stat");
        std::fs::write(process_dir.join("comm"), "codex\n").expect("fake comm");
        std::fs::write(process_dir.join("cmdline"), b"codex\0resume\0").expect("fake cmdline");
        symlink(release_binary, process_dir.join("exe")).expect("fake executable link");
    }

    fn assert_posix_shell_syntax(script: &str) -> bool {
        let mut child = match Command::new("sh").arg("-n").stdin(Stdio::piped()).spawn() {
            Ok(child) => child,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return false,
            Err(error) => panic!("could not start sh -n: {error}"),
        };
        child
            .stdin
            .as_mut()
            .expect("sh stdin")
            .write_all(script.as_bytes())
            .expect("write shell script");
        assert!(child.wait().expect("wait for sh -n").success());
        true
    }

    fn run_posix_shell(script: &str) -> Option<String> {
        match Command::new("sh").arg("-c").arg(script).output() {
            Ok(output) => {
                assert!(output.status.success());
                Some(String::from_utf8(output.stdout).expect("shell output"))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => panic!("could not execute sh: {error}"),
        }
    }

    #[test]
    fn process_preflight_parser_returns_compact_safe_metadata() {
        let output = concat!(
            "CODEXHUB_PROCESS=42\t1234\t636f646578\tapp-server\t302e3134352e30\t2f686f6d652f752f2e636f6465782f7061636b616765732f7374616e64616c6f6e652f72656c65617365732f302e3134352e30\n",
            "CODEXHUB_PROCESS_PREFLIGHT_STATUS=ready\n",
            "CODEXHUB_PROCESS_PREFLIGHT_COUNT=1\n",
            "CODEXHUB_PROCESS_PREFLIGHT_REASON=scan-complete\n"
        );
        let parsed = parse_remote_codex_process_preflight(output).expect("process preflight");
        assert_eq!(parsed[0].pid, 42);
        assert_eq!(parsed[0].process_name, "codex");
        assert_eq!(parsed[0].process_kind, RemoteCodexProcessKind::AppServer);
        assert_eq!(parsed[0].version, "0.145.0");
    }

    #[test]
    fn approved_process_identity_rejects_delimiter_characters() {
        let process = RemoteCodexProcessIdentity {
            pid: 42,
            start_time: "1234".into(),
            process_name: "codex\tworker".into(),
            process_kind: RemoteCodexProcessKind::CodexSession,
            version: "0.145.0".into(),
            release_path: "/home/u/.codex/packages/standalone/releases/0.145.0".into(),
        };
        assert!(validate_approved_processes(&[process]).is_err());
    }

    #[test]
    fn termination_script_uses_only_identity_checked_sigterm() {
        let process = RemoteCodexProcessIdentity {
            pid: 42,
            start_time: "1234".into(),
            process_name: "codex-code-mode".into(),
            process_kind: RemoteCodexProcessKind::AppServer,
            version: "0.145.0".into(),
            release_path: "/home/u/.codex/packages/standalone/releases/0.145.0".into(),
        };
        let script = remote_codex_process_termination_script(&[process], false);
        assert!(script.contains("kill -TERM \"$pid\""));
        assert!(script.contains("managed_start"));
        assert!(script.contains("managed_kind"));
        assert!(script.contains("process-impact-changed"));
        for forbidden in ["pkill", "killall", "SIGKILL", "kill -9", "kill -TERM -"] {
            assert!(!script.contains(forbidden), "unexpected {forbidden}");
        }
    }

    #[test]
    fn force_termination_is_explicit_bounded_and_identity_checked() {
        let process = RemoteCodexProcessIdentity {
            pid: 42,
            start_time: "1234".into(),
            process_name: "codex-code-mode".into(),
            process_kind: RemoteCodexProcessKind::AppServer,
            version: "0.145.0".into(),
            release_path: "/home/u/.codex/packages/standalone/releases/0.145.0".into(),
        };
        let script = remote_codex_process_termination_script(&[process], true);
        for required in [
            "kill -TERM \"$pid\"",
            "kill -KILL \"$pid\"",
            "[ \"$cycles\" -lt 6 ]",
            "approved_release_contains \"$release\"",
            "[ \"$managed_start\" = \"$start\" ]",
            "[ \"$managed_kind\" = \"$kind\" ]",
            "process-outside-approved-release",
            "force-stop-respawn-limit",
        ] {
            assert!(script.contains(required), "missing {required}");
        }
        for forbidden in ["pkill", "killall", "kill -9", "kill -- -", "kill -KILL -"] {
            assert!(!script.contains(forbidden), "unexpected {forbidden}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn force_termination_fixture_escalates_and_requires_two_empty_scans() {
        let fixture_root = std::env::temp_dir().join(format!(
            "codexhub-force-stop-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let proc_root = fixture_root.join("proc");
        let release_root = fixture_root.join("releases");
        let release_dir = release_root.join("0.145.0");
        let release_binary = release_dir.join("bin/codex");
        std::fs::create_dir_all(release_binary.parent().expect("release bin"))
            .expect("release fixture");
        std::fs::write(&release_binary, "fixture").expect("release binary");
        write_fake_process(&proc_root, &release_binary, 42, "1234");

        let process = RemoteCodexProcessIdentity {
            pid: 42,
            start_time: "1234".into(),
            process_name: "codex".into(),
            process_kind: RemoteCodexProcessKind::CodexSession,
            version: "0.145.0".into(),
            release_path: release_dir.to_string_lossy().into_owned(),
        };
        let script = remote_codex_process_termination_script(&[process], true)
            .replace(
                "kill -TERM \"$pid\" 2>/dev/null",
                "fixture_kill TERM \"$pid\"",
            )
            .replace(
                "kill -KILL \"$pid\" 2>/dev/null",
                "fixture_kill KILL \"$pid\"",
            )
            .replace("sleep 1", ":");
        let script = format!(
            "fixture_kill() {{ [ \"$1\" = TERM ] || mv \"$CODEXHUB_PROC_ROOT/$2\" \"$CODEXHUB_PROC_ROOT/stopped-$2\"; }}\n{script}"
        );
        let output = Command::new("sh")
            .arg("-c")
            .arg(script)
            .env("CODEXHUB_PROC_ROOT", &proc_root)
            .env("CODEXHUB_RELEASE_ROOT", &release_root)
            .env("TMPDIR", &fixture_root)
            .output()
            .expect("run force-stop fixture");
        let stdout = String::from_utf8(output.stdout).expect("fixture stdout");
        assert!(output.status.success(), "{stdout}");
        assert!(stdout.contains("CODEXHUB_PROCESS_TERMINATION_STATUS=stopped"));
        assert!(stdout.contains("CODEXHUB_PROCESS_TERMINATION_FORCED=1"));
        assert!(stdout.contains("CODEXHUB_PROCESS_TERMINATION_REASON=force-completed"));
        std::fs::remove_dir_all(&fixture_root).expect("remove fixture");
    }

    #[test]
    fn unknown_process_kind_cannot_be_approved_for_termination() {
        let process = RemoteCodexProcessIdentity {
            pid: 42,
            start_time: "1234".into(),
            process_name: "codex".into(),
            process_kind: RemoteCodexProcessKind::Unknown,
            version: "0.145.0".into(),
            release_path: "/home/u/.codex/packages/standalone/releases/0.145.0".into(),
        };
        assert!(validate_approved_processes(&[process]).is_err());
    }

    #[test]
    fn preflight_script_covers_executable_and_memory_mapping_identity() {
        let script = remote_codex_process_preflight_script();
        assert!(script.contains("$candidate_dir/exe"));
        assert!(script.contains("$match_dir/maps"));
        assert!(script.contains("CODEXHUB_PROCESS_PREFLIGHT_STATUS"));
    }

    #[test]
    fn process_kind_classification_matches_app_services_and_sessions() {
        let cases = [
            (
                "2f62696e2f636f646578006170702d7365727665720070726f787900",
                "app-server-proxy",
            ),
            (
                "2f62696e2f636f646578002d630066656174757265732e636f64655f6d6f64655f686f73743d74727565006170702d736572766572002d2d6c697374656e00756e69783a2f2f00",
                "app-server",
            ),
            ("2f62696e2f636f64657800726573756d6500", "codex-session"),
            ("", "unknown"),
        ];
        for (cmdline_hex, expected) in cases {
            let script = format!(
                "{PROCESS_DISCOVERY_FUNCTIONS}\nclassify_cmdline_hex '{cmdline_hex}'\nprintf '%s' \"$managed_kind\""
            );
            let Some(actual) = run_posix_shell(&script) else {
                return;
            };
            assert_eq!(actual, expected);
        }
    }

    #[test]
    fn process_gate_scripts_are_posix_shell_syntax() {
        let process = RemoteCodexProcessIdentity {
            pid: 42,
            start_time: "1234".into(),
            process_name: "codex-code-mode".into(),
            process_kind: RemoteCodexProcessKind::AppServerProxy,
            version: "0.145.0".into(),
            release_path: "/home/u/.codex/packages/standalone/releases/0.145.0".into(),
        };
        if !assert_posix_shell_syntax(&remote_codex_process_preflight_script()) {
            return;
        }
        assert!(assert_posix_shell_syntax(
            &remote_codex_process_termination_script(&[process.clone()], false)
        ));
        assert!(assert_posix_shell_syntax(
            &remote_codex_process_termination_script(&[process], true)
        ));
    }
}
