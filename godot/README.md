# TYAGA Godot Auth Example

These scripts are an integration example for a Godot 4 client.
They use only the public TYAGA API and never contain server secrets.

Flow:

1. `POST /auth/device/start`
2. Open the returned `auth_url`
3. Poll `POST /auth/device/status` with the challenge in JSON
4. Exchange the returned `exchange_code`
5. Call `GET /auth/me` with `Authorization: Bearer <token>`
6. Save the player response to `user://player.json`

Example usage from a Godot node:

```gdscript
var auth_result = await authenticate_player()
if auth_result.success:
    print(auth_result.player)
```

After a successful exchange, the session token is encrypted into
`user://tyaga_session.bin`; its local AES key is stored separately in
`user://tyaga_session.key`. The ciphertext also has an HMAC integrity check.
On the next start, `auth.gd` restores the token,
calls `/auth/me`, updates `PlayerData`, saves `user://player.json`, and opens
`main.tscn` without Telegram authorization.

If `/auth/me` returns `401`, the stored session is removed and the auth scene
remains available. Network errors do not delete the token, so a temporary
connection failure does not force a new login.

The token is never written to `user://player.json`. In a browser export,
Godot's `user://` storage is persisted by the browser, typically through
IndexedDB. Client-side encryption protects the stored value from casual
inspection, but cannot protect it from malicious JavaScript running in the
same origin because the application must be able to decrypt and use it.

Use `auth.gd`, `player_auth.gd`, and `auth_client.gd` in the auth scene.
Keep `auth.tscn` as the project's startup scene; it redirects to
`main.tscn` after restoring a valid session.
