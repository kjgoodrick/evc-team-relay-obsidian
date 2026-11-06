import { commentMarkdownParser } from "./blocks";

const highlight = { resolve: "ReadingHighlight", mark: "ReadingHighlightMark" };

/** These extensions only describe candidate source positions. The Reading
 * mapper still requires an exact comparison with the host's actual rendering.
 * Keep them separate from the source-block parser and its block boundaries. */
export const readingMarkdownParser = commentMarkdownParser.configure({
	defineNodes: ["ReadingWikiLink", "ReadingWikiEmbed", "ReadingHiddenComment", "ReadingHighlight", "ReadingHighlightMark"],
	parseInline: [{
		name: "ReadingWikiLink", before: "Link",
		parse(cx, next, pos) {
			const embedded = next === 33, start = pos + (embedded ? 1 : 0);
			if (cx.char(start) !== 91 || cx.char(start + 1) !== 91) return -1;
			// A bounded scan avoids quadratic work on long malformed bracket runs.
			// Unusually long/unsupported links retain the explicit block fallback.
			for (let end = start + 2; end < Math.min(cx.end, start + 4096); end++) {
				const char = cx.char(end);
				if (char === 10 || char === 13 || char === 91) return -1;
				if (char === 93) return end > start + 2 && cx.char(end + 1) === 93
					? cx.addElement(cx.elt(embedded ? "ReadingWikiEmbed" : "ReadingWikiLink", pos, end + 2)) : -1;
			}
			return -1;
		},
	}, {
		name: "ReadingHiddenComment", before: "Emphasis",
		parse(cx, next, pos) {
			if (next !== 37 || cx.char(pos + 1) !== 37) return -1;
			// Core inline comments close on the same line. Multiline/block comment
			// structure needs its own block parser; do not guess across paragraphs.
			for (let end = pos + 2; end < cx.end; end++) {
				if (cx.char(end) === 10 || cx.char(end) === 13) return -1;
				if (cx.char(end) === 37 && cx.char(end + 1) === 37) return cx.addElement(cx.elt("ReadingHiddenComment", pos, end + 2));
			}
			return -1;
		},
	}, {
		name: "ReadingHighlight", after: "Emphasis",
		parse(cx, next, pos) {
			if (next !== 61 || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61 || cx.char(pos - 1) === 61) return -1;
			const before = cx.slice(pos - 1, pos), after = cx.slice(pos + 2, pos + 3);
			return cx.addDelimiter(highlight, pos, pos + 2, !/\s|^$/.test(after), !/\s|^$/.test(before));
		},
	}],
});
