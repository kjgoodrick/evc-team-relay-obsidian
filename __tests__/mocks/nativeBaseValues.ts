/** Minimal observed 1.13.7 Value representation, independent of formatted DOM. */
export class Value {}
export class NullValue extends Value { static value = new NullValue(); }
export class StringValue extends Value { constructor(public data: string) { super(); } }
export class NumberValue extends Value { constructor(public data: number) { super(); } }
export class BooleanValue extends Value { constructor(public data: boolean) { super(); } }
export class DateValue extends Value { constructor(public date: Date, public time: boolean) { super(); } }
export class DurationValue extends Value {
	years = 0; months = 0; days = 0; hours = 0; minutes = 0; seconds = 0; milliseconds = 0;
}
export class TFile { path = ""; }
export class FileValue extends Value { constructor(public file: TFile) { super(); } }
export class UrlValue extends StringValue {}
export class LinkValue extends StringValue { sourcePath = ""; display: unknown; }
export class ListValue extends Value {
	constructor(public data: unknown[]) { super(); }
	length() { return this.data.length; }
	get(index: number) { return this.data[index]; }
}
export function parseLinktext(link: string) {
	const index = link.indexOf("#");
	return { path: index < 0 ? link : link.slice(0, index), subpath: index < 0 ? "" : link.slice(index) };
}
