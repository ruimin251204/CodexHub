import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import { createPersonalInfoMasker } from "../personalInfo";
import type { PersonalInfoMasker } from "../personalInfo";

const PersonalInfoMaskingContext = createContext<PersonalInfoMasker>(createPersonalInfoMasker(false));

export function PersonalInfoMaskingProvider({
  children,
  value
}: {
  children: ReactNode;
  value: PersonalInfoMasker;
}) {
  return <PersonalInfoMaskingContext.Provider value={value}>{children}</PersonalInfoMaskingContext.Provider>;
}

export function usePersonalInfoMasking() {
  return useContext(PersonalInfoMaskingContext);
}
