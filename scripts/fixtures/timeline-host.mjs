// Only the Obsidian API is mocked. Both plugins' production code is bundled.
export * from "timeline-test-host";
export { TFile, Value, NullValue, StringValue, NumberValue, BooleanValue, DateValue,
	DurationValue, FileValue, UrlValue, TagValue, LinkValue, ListValue, parseLinktext } from "../../__tests__/mocks/nativeBaseValues.ts";
export const parseYaml = JSON.parse;
