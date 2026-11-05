import { Account } from "../src/Account";
import { presenceColorForUser } from "../src/presenceColor";

test("restoring an account, changing its profile or receiving an older peer keeps its identity color", () => {
	const original = new Account("person-123", "Alice", "a@example.com", "", "first");
	for (let i = 0; i < 32; i++) {
		const restored = new Account(original.accountId, "New name " + i, "new@example.com", "https://id.example/new.png", "refreshed");
		expect(restored.presenceColor).toEqual(original.presenceColor);
		expect(presenceColorForUser({ id: original.accountId, color: "#ffffff", colorLight: "#000000" })).toEqual(original.presenceColor);
	}
	// A small palette can repeat, but must not collapse every identity to one color.
	expect(new Set(Array.from({ length: 32 }, (_, i) => presenceColorForUser({ id: "person-" + i }).color)).size).toBeGreaterThan(1);
});

test.each([undefined, null, 123, ""])("anonymous legacy identity %s retains its advertised cursor color", id => {
	expect(presenceColorForUser({ id, color: "#abcdef" })).toEqual({ color: "#abcdef", light: "#abcdef33" });
	expect(presenceColorForUser({ id })).toEqual({ color: "#30bced", light: "#30bced33" });
});
