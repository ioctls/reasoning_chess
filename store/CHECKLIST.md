# Publishing checklist

## One-time setup
1. **Developer account:** play.google.com/console → Personal account → pay US$25 → verify identity (government ID).
2. **Upload key → GitHub:** add the 4 secrets from `github-secrets.txt` at
   https://github.com/ioctls/reasoning_chess/settings/secrets/actions
   The next build then also produces a signed `reasonable-chess.aab` in Releases → Latest build.
3. **Create the app** in Play Console: name "Reasonable Chess", default language English (US), **Game**, **Free**.
4. **App content:** fill in everything in `DATA_SAFETY.md`.
5. **Store listing:** paste from `LISTING.md`, upload the graphics in this folder.

## Testing (required for new personal accounts)
6. **Internal testing** (optional but quick): Testing → Internal testing → upload `reasonable-chess.aab`. Play App Signing is offered on first upload: accept it (Google keeps the app signing key; yours is only the upload key).
7. **Closed testing:** create a closed track → add at least **12 testers** (their Google account emails, or a Google Group) → upload the `.aab` → send testers the opt-in link.
8. Testers stay opted in for **14 consecutive days** and actually use the app.

## Production
9. Dashboard → **Apply for production access** → answer the questions about your test.
10. After approval: Production → create release → same `.aab` (or a newer one) → roll out.

## Every update after that
Push to `main` → GitHub builds a new `.aab` with a higher version code automatically → upload it in Play Console.
