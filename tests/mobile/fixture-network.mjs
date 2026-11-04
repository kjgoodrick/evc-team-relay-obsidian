// Only network boundary replaced; transport and recovery algorithms remain production imports.
export const fixture = { manifest: { records: {}, permissions: {}, activity: {}, owner: true }, challenge: '', pending: 0, deny: false };
export async function platformFetch(url, init = {}) {
    const body = init.body ? JSON.parse(init.body) : {};
    const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
    if (String(url).endsWith('/start')) {
        fixture.challenge = body.challenge;
        return response({ id: 'synthetic', authorize_url: 'https://example.invalid/synthetic-oidc', expires_in: 20, interval: 2 });
    }
    if (String(url).endsWith('/complete')) {
        if (fixture.pending++ === 0)
            return response({}, 202);
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.verifier)));
        const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        if (challenge !== fixture.challenge)
            return response({}, 403);
        return response({ user_id: 'fixture-user', user_email: 'mobile@example.invalid', access_token: 'synthetic-only', refresh_token: 'synthetic-only', expires_in: 60 });
    }
    if (String(url).endsWith('/cancel'))
        return response({});
    if (init.method === 'POST') {
        if (fixture.deny)
            return response({}, 403);
        if (body.changes?.some(c => JSON.stringify(fixture.manifest.records[c.path] ?? null) !== JSON.stringify(c.previous)))
            return response({}, 409);
        for (const c of body.changes ?? []) {
            if (c.value)
                fixture.manifest.records[c.path] = c.value;
            else
                delete fixture.manifest.records[c.path];
        }
    }
    return response(fixture.manifest);
}
