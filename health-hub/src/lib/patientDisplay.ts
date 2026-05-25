import type { Title } from "@/types";

export const TITLE_TO_GENDER: Record<string, "M" | "F" | undefined> = {
  MR: "M",
  MASTER: "M",
  MRS: "F",
  MS: "F",
};

export const titleOptions: { value: Title | ""; label: string }[] = [
  { value: "", label: "None" },
  { value: "MR", label: "Mr" },
  { value: "MRS", label: "Mrs" },
  { value: "MS", label: "Ms" },
  { value: "MASTER", label: "Master" },
  { value: "BABY", label: "Baby" },
];

export function formatTitleLabel(title?: string | null): string {
  switch (title) {
    case "MR":
      return "Mr.";
    case "MRS":
      return "Mrs.";
    case "MS":
      return "Ms.";
    case "MASTER":
      return "Master";
    case "BABY":
      return "Baby";
    default:
      return "";
  }
}

export function formatPatientName(
  name: string,
  title?: string | null,
  uppercase?: boolean,
): string {
  const safeName = name ?? "Unknown";
  const displayName = uppercase ? safeName.toUpperCase() : safeName;
  const prefix = formatTitleLabel(title);
  return prefix ? `${prefix} ${displayName}` : displayName;
}
