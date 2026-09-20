// This package ships TypeScript extension sources without a declaration entry.
// Keep its external contract here; integration tests execute the real package
// against the pinned SDK. The adapter always supplies an AbortSignal, which the
// upstream implementation assumes despite the SDK's optional signal type.
declare const extension: import("@earendil-works/pi-coding-agent").ExtensionFactory;
export default extension;
