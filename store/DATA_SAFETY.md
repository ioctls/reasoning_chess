# Play Console answers: Data safety, content rating, app content

## Data safety (Policy → App content → Data safety)

| Question | Answer |
|---|---|
| Does your app collect or share any of the required user data types? | **No** |
| (If asked) Is all user data encrypted in transit? | Not applicable: no data is transmitted |
| (If asked) Do you provide a way for users to request that their data is deleted? | Not applicable: no data is collected. Data stays on the device; uninstalling deletes it. |

Result shown on Play: **"No data collected · No data shared with third parties."**

Why this is accurate: the app declares no permissions (CI checks this on every build), bundles everything it needs, turns off WebView Safe Browsing and metrics, and has no SDKs for ads, analytics or crash reporting. Stats live only in the app's private storage and are excluded from cloud backup.

## Content rating questionnaire (IARC)

- Category: **Game** (Board / Puzzle)
- Violence, fear, sexuality, language, controlled substances, crude humor: **No** to all
- Gambling or simulated gambling: **No**
- Users can interact or exchange content with each other: **No**
- Shares user location: **No**
- Allows purchases of digital goods: **No**
- Expected rating: **Everyone / PEGI 3**

## Other "App content" declarations

| Item | Answer |
|---|---|
| Privacy policy | https://github.com/ioctls/reasoning_chess/blob/main/PRIVACY.md |
| Ads | **No**, the app does not contain ads |
| App access | All functionality is available without login or special access |
| Target audience | 13+ is simplest. The app suits all ages, but targeting under-13s adds Families-policy review. |
| News app | No |
| COVID-19 contact tracing / status | No |
| Data safety | See above |
| Government app | No |
| Financial features | None |
| Health | No |
| Price | **Free** (a free app can never later be changed to paid on Play) |
