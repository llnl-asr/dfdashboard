// The Arrow decoders, kept in their own module so Vite can split apache-arrow
// out of the entry chunk: the timeline is the only view that decodes Arrow, and
// a reader who never opens it should not download the decoder.
import { RecordBatchReader, tableFromIPC } from "apache-arrow";

export { RecordBatchReader, tableFromIPC };

export type ArrowTable = ReturnType<typeof tableFromIPC>;
