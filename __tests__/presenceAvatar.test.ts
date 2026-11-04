import { safeAvatarUrl } from "../src/presenceAvatar";

test.each([undefined, null, 123, "", "file:///etc/passwd", "javascript:alert(1)", "data:image/svg+xml,a", "http://remote.example/a.png", "https://user:secret@example.com/a.png", "https://example.com/" + "a".repeat(2048)])("rejects unsafe avatar URL %s", value => {
	expect(safeAvatarUrl(value)).toBeUndefined();
});
test("accepts HTTPS pictures and loopback development fixtures", () => {
	expect(safeAvatarUrl("https://id.example/api/users/u/profile-picture.png")).toBe("https://id.example/api/users/u/profile-picture.png");
	expect(safeAvatarUrl("http://127.0.0.1:4177/avatar.png")).toBe("http://127.0.0.1:4177/avatar.png");
});
