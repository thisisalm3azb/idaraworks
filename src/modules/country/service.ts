/**
 * H29 — the country module's only door (BUILD_BIBLE §3.3). Pages, actions and
 * other modules import from here; nothing reaches into the module's internals.
 */
export {
  CountryError,
  CreateEstablishmentInput,
  UpdateEstablishmentInput,
  SetRegistrationInput,
  createEstablishment,
  updateEstablishment,
  effectiveConfig,
  getEstablishment,
  listEstablishments,
  listRegistrations,
  setRegistration,
  mayViewCountries,
} from "./establishments";

export { establishmentReadiness, organisationReadiness } from "./readiness";

export {
  AdoptPackInput,
  adoptPack,
  listAdoptions,
  packTimeline,
  previewAdoption,
} from "./adoption";

export type {
  AdoptionRow,
  AreaReadiness,
  EffectiveConfig,
  EstablishmentReadiness,
  EstablishmentRow,
  ImpactLine,
  ImpactPreview,
  ReadinessArea,
  ReadinessCheck,
  RegistrationRow,
} from "./types";
