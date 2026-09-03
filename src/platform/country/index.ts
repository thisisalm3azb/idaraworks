/**
 * H29 — the country-pack platform substrate. One import surface so no module
 * reaches into a pack file directly.
 */
export * from "./types";
export {
  COUNTRY_PACKS,
  PACK_COUNTRIES,
  getPack,
  packsFor,
  resolvePack,
  nextPackAfter,
  countrySupported,
  registryProblems,
  assertRegistryIsSound,
  type RegistryProblem,
} from "./registry";
export {
  ibanProblems,
  formatIban,
  identifierProblems,
  addressProblems,
  formatAddress,
  phoneProblems,
  type FieldProblem,
  type AddressValue,
} from "./identity";
export {
  formatAmount,
  formatPercent,
  formatBusinessDate,
  formatInstant,
  formatHijriDate,
  weekdayOf,
  type FormattingContext,
} from "./format";
export { AE_PACK } from "./packs/ae";
export { SA_PACK } from "./packs/sa";
