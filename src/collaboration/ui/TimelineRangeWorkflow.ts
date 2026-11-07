import { Notice, type App } from "obsidian";
import type { NativeTimelineContext, NativeTimelineSelection } from "../../bases/NativeBasesSurface";
import type { BaseCommentContext } from "../BaseCommentContext";
import type { HistoricalPoint, TimelineRange } from "../TimelineRange";
import type { TimelineAxisContext } from "../TimelineRangeProtocol";
import { readNativeTimelineAxis } from "../NativeTimelineRanges";
import { TimelineRangeModal, type TimelineRangeFormState } from "./TimelineRangeModal";

/** Owns the transition between a native modal and renderer selection. No task,
 * config, permission or durable comment changes happen until explicit save. */
export class TimelineRangeWorkflow {
	private closed = false;
	private modal?: TimelineRangeModal;
	private stop?: () => void;
	private serial = 0;
	private proof?: TimelineAxisContext;
	private native?: NativeTimelineContext;
	constructor(private app: App, private context: BaseCommentContext, private active: () => boolean,
		private save: (proof: TimelineAxisContext, range: TimelineRange, current: () => boolean) => Promise<boolean>) {}
	private current = () => !this.closed && this.active() && this.context.current() && this.context.session.permission(this.context.entryId)?.comment === true &&
		this.context.session.canAnchorBase("timeline_range") && this.native?.current() === true;
	async open(): Promise<void> {
		try {
			this.native = this.context.surface.rangeContext();
			if (!this.current()) return;
			this.proof = await readNativeTimelineAxis(this.context, this.native);
			if (this.current()) this.show();
		} catch (error) { if (!this.closed && this.active()) new Notice(error instanceof Error ? error.message : "The timeline axis could not be verified."); }
	}
	private show(draft?: Record<string, unknown>, issue?: string, selection?: NativeTimelineSelection, state?: TimelineRangeFormState): void {
		if (this.closed || !this.native || !this.proof) return;
		const serial = ++this.serial, current = () => serial === this.serial && this.current() && (!selection || selection.current());
		const modal = new TimelineRangeModal(this.app, { viewName: this.context.binding.name, context: this.native, draft, issue, state, current,
			save: (range: TimelineRange) => current() ? this.save(this.proof!, range, current) : Promise.resolve(false),
			pick: (draft, precision, state) => { this.modal = undefined; if (serial === this.serial) this.pick(draft, precision, state); },
			closed: () => { if (this.modal === modal) this.close(); },
		});
		this.modal = modal; modal.open();
	}
	private pick(draft: Record<string, unknown>, precision: HistoricalPoint["precision"], state: TimelineRangeFormState): void {
		if (!this.current()) { this.show(draft, undefined, undefined, state); return; }
		const serial = ++this.serial; let delivered = false, ended = false;
		const stop = this.context.surface.beginRange(draft.kind as TimelineRange["kind"], precision, selection => {
			if (this.closed || serial !== this.serial || !this.current() || !selection.current()) return;
			delivered = true; this.stop = undefined; this.show(selection.draft ?? draft, selection.issue, selection, selection.draft ? undefined : state);
		}, () => {
			ended = true; this.stop = undefined;
			// The provider releases handlers before delivering a completed range.
			void Promise.resolve().then(() => {
				if (!this.closed && serial === this.serial && !delivered) this.show(draft, "Selection cancelled. Your entered endpoints are retained.", undefined, state);
			});
		});
		if (!stop) { if (!ended) this.show(draft, "Selection is unavailable. Close the task inspector or enter endpoints here.", undefined, state); }
		else if (!ended) this.stop = stop;
	}
	validate(): void { this.modal?.validate(); if (!this.current()) this.stop?.(); }
	close(): void {
		if (this.closed) return; this.closed = true; this.serial++;
		const stop = this.stop, modal = this.modal; this.stop = undefined; this.modal = undefined;
		stop?.(); modal?.close();
	}
}
