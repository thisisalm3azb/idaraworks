/**
 * H29 — the electronic-invoicing module's only door.
 */
export {
  EInvoiceError,
  CreateChannelInput,
  ConfigureChannelInput,
  createChannel,
  configureChannel,
  listChannels,
  type ChannelRow,
} from "./channels";

export {
  PrepareInput,
  prepareDocument,
  submitDocument,
  listDocuments,
  type EInvoiceDocumentRow,
  type PrepareResult,
  type SubmitResult,
} from "./documents";

export { EINVOICE_ADAPTERS, adapterFor, adaptersForCountry, credentialPresent } from "./registry";

export { ZATCA_OWNER_ACTION, encodeQr, sha256Base64, tlv } from "./adapters/zatca";
export { UAE_OWNER_ACTION } from "./adapters/uae-peppol";
export type {
  AdapterContext,
  EInvoiceAdapter,
  EInvoiceEnvironment,
  PreparedDocument,
  SourceDocument,
  SubmitOutcome,
  ValidationIssue,
} from "./adapters/types";
