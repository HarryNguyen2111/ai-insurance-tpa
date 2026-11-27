# #106 — User-centric Mini App shell, workspace avatar switcher, Loyalty360 / TPA separation

Status: **design + SYNTHETIC interactive prototype** (apps/zalo-miniapp only). No backend, API, migration, Zalo
integration, loyalty engine, notification runtime or Phase 1 claim/payment rule is added or changed. Every
"backend" response comes from `src/adapters/synthetic.ts`. Tests prove prototype behaviour only; real
membership/RLS/consent behaviour needs the contracts in §7 and their runtime tasks.

Owner decisions applied (issue #106 body, 2026-11-27): user-centric hub; double-tap tenant avatar round robin;
**no tenant ⇒ personal Loyalty360 home** (not an empty chooser, not an all-tenant view); the ring includes an
explicit "Loyalty360 cá nhân" entry; tenant theme from #72 / docs/ai-specs/13 with OD-WS1 (low contrast warns,
never blocks); notifications only as a placeholder slot (#107 owns the centre).

## 1. Screen map (H0–H5)

| Screen | Route | Actor | Shows | Bar |
| --- | --- | --- | --- | --- |
| H0 home | `/hub` | verified principal | personal context → personal Loyalty360 home (tier/points/benefits, tenant-access help). tenant context → that tenant's capability-approved service tiles + minimal activity pointers | hub bar |
| H1 workspace sheet | overlay | same | current context, stable ordered list (personal + memberships), logo-mark/name/✓/service badges, refresh, "request access" (never self-grants) | – |
| H2 Loyalty360 | `/loyalty` | same | programme tier/points/benefits of the ACTIVE context (personal programme or tenant programme); own menu (Tổng quan / Ưu đãi / Lịch sử điểm — last two "sắp có") | hub bar |
| H3 TPA Insurance | `/home` (+ existing `/ecard`, `/claims`, `/claims/:id`, `/claims/:id/eob`, `/claims/new`, `/consent`) | member of a TPA-capable tenant | #74/#104 content, now read from the active tenant's committed snapshot | #104 TPA bar (unchanged) |
| H4 activity | `/hub/activity` | same | pointers for the active context only (no amounts, no health data) | hub bar |
| H5 personal | `/hub/personal` | same | masked profile, per-service consent status, remembered preference, labelled prototype controls | hub bar |

Entry: onboarding `/` keeps "Bắt đầu" (TPA consent flow, unchanged so #74/#104 tests and routes stay valid) and
adds "Mở trang tiện ích cá nhân" → H0. **Open decision**: production entry should be H0; switching the default
entry changes the #104-tested flow and is left to the owner (see §8).

Header on H0/H2/H3/H4/H5: person avatar (circle, initials, caption "Tài khoản" → H5) · workspace avatar (rounded
square on tenant brand, caption "Đơn vị"/"Không gian", name, chevron; hint "Nhấn đúp để chuyển nhanh" only when
the ring has ≥ 2 entries) · bell placeholder (#107, `aria-disabled`, no count). Services add a row "‹ Trang tiện
ích · [service badge]" so Loyalty360 and TPA are visibly different services under the same tenant theme.

Bottom navigation: hub screens use the proposed **Trang chủ / Tiện ích (sắp có) / Hoạt động / Cá nhân**. TPA
screens keep the #104 bar (Trang chủ / Hồ sơ / Gửi hồ sơ / Thẻ BH / Cá nhân-sắp có) as the TPA service menu. All
#104 routes remain reachable; unavailable destinations explain themselves and never fake a screen.

### States per screen

| State | Trigger | Rendering (all screens) |
| --- | --- | --- |
| loading/switching | start-up, any switch | neutral theme, workspace avatar shows TARGET name + "Đang chuyển…", `aria-busy`; service body = skeleton "Đang mở X…"; **no data of the previous or target tenant** |
| empty | 0 memberships | personal Loyalty360 home; "Đơn vị của bạn" explains verification by the insurer, no auto-link by name/phone |
| forbidden/revoked | 403 on select, or authoritative refresh drops the active tenant | `role=alert` "Không chuyển được sang X: quyền … không còn hiệu lực"; no retry; "Quay lại {previous}" / "Chọn không gian khác"; entry removed from ring |
| error / offline | adapter ERROR / OFFLINE | same alert with "Thử lại"; never auto-advances to another tenant |
| service unavailable | tenant lacks capability | tile hidden on H0; direct route explains "chưa bật dịch vụ … Mini App không tự bật" |
| needs tenant | TPA route in personal context | "Hãy chọn đơn vị đã cấp quyền" + chooser |
| expired | – | **gap**: `MembershipContext.expiresAt` exists [02] but no refresh flow is defined (G6); prototype tokens never expire |
| invalid theme | payload fails `^#[0-9a-f]{6}$` | neutral theme + "đang dùng giao diện trung tính" |

## 2. Field / action matrix (UI → source → permission → test)

`[02]` = exists in docs/ai-specs/02; `[Gn]` = proposed gap (§7); unit = `src/lib/*.test.ts`; e2e-S =
`e2e/workspace-switch.spec.ts`; e2e-T = `e2e/tenant-theme.spec.ts`.

| UI element | Data class | Source | Permission | Test |
| --- | --- | --- | --- | --- |
| Person initials / masked name | (a) | `PersonalProfile` [G5] | own principal | e2e-S "distinct, labelled" |
| Workspace name, short name, order | (b) | `Membership.membershipId/version` [02] + `workspace.displayName/shortName` [G1]; order client-side (§3) | server-listed active grant | unit context-ring; e2e-S ring |
| Service badges / tiles | (b) | `services[]` [G2] | capability from server; branding never implies access | e2e-S capability filter |
| Theme tokens | (b) | `WorkspaceTheme.primaryColor` [02 admin] via member read [G3] + `brandingVersion` [G1] | authorised membership | unit theme; e2e-T |
| Personal tier / points / benefits | (a) | `PersonalLoyaltyHome` [G4] | own principal, no membership context | unit switcher; e2e-S 0 memberships |
| Tenant tier / points / benefits | (c) | `TenantLoyaltyData` [G4] | membership + LOYALTY360 capability | e2e-S service switch |
| Plan, e-card, claims, claim detail, EOB | (c) | existing [02] schemas (ECard, ClaimSummary, ClaimDetail, ExplainableEOBResponse) per tenant snapshot | membership context header [02] + object checks | existing smoke/navigation e2e; e2e-S flash/deeplink |
| TPA consent status | (c) | `/v1/consents` [02], scoped per tenant | membership | e2e-S draft test (B needs own consent) |
| Loyalty360 consent | (a)/(c) | none [G9] | – | shown "chưa có" (H5) |
| Activity pointers | derived | counts from the active snapshot only | active context | e2e-S toast/activity screenshots |
| Action: single tap avatar | – | – | – | unit tap-arbiter; e2e-S single tap |
| Action: double tap avatar | – | `POST /v1/me/membership` [02] | server re-authorises | unit; e2e-S ring, rapid |
| Action: choose in sheet | – | same | same | e2e-S keyboard |
| Action: refresh list | – | `GET /v1/me/memberships` [02] | authoritative | e2e-S revoked |
| Action: request access | – | none (would be #21) | never self-grants | text only |
| Action: bell | – | none (#107) | – | e2e-S bell placeholder |

## 3. Interaction state machine

Ring (stable, `lib/context-ring.ts`): `[PERSONAL, ...memberships sorted by Intl.Collator('vi') on displayName,
tie → membershipId]`. Not MRU; identical to sheet order (numbered). Contains only entries of the latest
authoritative list.

Tap arbitration (`lib/tap-arbiter.ts`, `DOUBLE_TAP_MS = 300`):

```
pointer tap ─▶ pending ──(300 ms)──▶ SINGLE → open sheet
                 └─ 2nd tap < 300 ms ─▶ DOUBLE → requestSwitch(NEXT); cooldown 300 ms (3rd tap ignored)
keyboard / AT activation (click.detail = 0) ─▶ SINGLE immediately
ring length 1 (0 memberships) ─▶ SINGLE immediately (no gesture, no delay)
```
`touch-action: manipulation` on the avatar only; no global `preventDefault`/viewport zoom hacks.

Switch (`lib/context-switcher.ts`):

```
ready(A) ─switchTo(B)─▶ switching(B) [abort A's in-flight calls; theme neutral; A data dropped]
switching(B) ─select✓ theme✓ data✓ (same generation)─▶ ready(B) [label+theme+data in one commit]
switching(B) ─403─▶ refresh memberships ─▶ failed(B,REVOKED)   (B leaves the ring; no auto-advance)
switching(B) ─offline/error─▶ failed(B,OFFLINE|ERROR)           (retry / return / choose)
switching(B) ─switchTo(C)─▶ switching(C) [late B responses counted in staleDropped and dropped]
quickSwitch while switching ─▶ ignored (bounded rapid taps)
refresh shows active tenant revoked ─▶ failed(active,REVOKED), data cleared
```
Before any switch, `requestSwitch` checks the CURRENT scope's FNOL draft (files picked or "Lưu nháp"): dialog
"Ở lại / Giữ nháp tại {A} và chuyển / Bỏ nháp và chuyển". Drafts are keyed
`principal|context|TPA_INSURANCE|fnol-draft|formVersion`; never moved, never auto-submitted. OTP stays disabled in
the prototype; any future OTP/approval must bind the EOB version and be invalidated by a context change (AGENTS §5).

Success → toast (`aria-live=polite`) "Đã chuyển sang X." + "Quay lại {previous}" (an explicit, re-authorised
switch). Theme is applied in a layout effect from the committed state only.

## 4. Data and privacy boundaries

- Classes: (a) personal identity/preferences — `PersonalProfile`, `PersonalLoyaltyHome`; (b) tenant branding and
  capabilities — `WorkspaceMembership.workspace/services`, theme; (c) tenant+service records — `TenantTpaData`,
  `TenantLoyaltyData`. Separate types; no shared customer object (`adapters/ports.ts`).
- Personal context is the person's own programme: not a super-tenant, no pooled points, no tenant data, no
  medical/claim personalisation. Loyalty data contains no insurance/health/bank field (unit + e2e text check).
- Same tenant may hold both services (An Bình, Bình Minh); Cát Tường is Loyalty360-only; tiles follow
  `services[]` only.
- Consent is scoped per context (TPA consent of A does not apply to B). Loyalty360 consent has no contract (G9).
- Memory only: context tokens, snapshots, drafts, theme cache, preference. Nothing in localStorage/cookies/URLs;
  no PII in cache keys (`theme:{membershipId}:v{n}`, `v1|principal|context|service|entity|version`).
- Deep links: claim/EOB routes look up the id only in the active tenant's snapshot; unknown and foreign ids get the
  same "không tìm thấy … hoặc không có quyền" text (no existence leak). Backend object checks remain the authority.
- Activity/home are pointers for the active context, not a cross-tenant claims endpoint.

## 5. Theme tokens (`lib/theme.ts`, `styles.css`)

Input: `WorkspaceTheme.primaryColor` only (closed allowlist; no CSS/URL/HTML). Re-validated client-side; invalid →
neutral. Output CSS variables (set on `<html>` from the committed context only):

| Token | Rule | Used by |
| --- | --- | --- |
| `--brand` | stored colour, unchanged | fills: zaui primary button, raised action, slides, tenant mark, loyalty card |
| `--brand-on` | white/black with higher contrast (spec 13, ≥ 4.5:1) | text/icons on brand fills |
| `--brand-pressed` | brand mixed 15 % toward black | pressed fill, slide gradient |
| `--brand-soft` | brand mixed 86 % toward white | secondary button, tile icon, service badge |
| `--brand-ink` | brand darkened in 5 % steps until ≥ 4.5:1 on card/page/warm surfaces | links, selected tab, focus ring, chips, checkbox accent |
| `--brand-border` | `--brand-ink` when brand < 3:1 on any surface, else transparent | outline of brand fills (OD-WS1 fallback) |

`LOW_SURFACE_CONTRAST` (brand vs page < 3:1) → warning text on H0 + `data-theme-warning`; never blocks, never alters
the stored colour. zmp-ui configured only through its `--zaui-light-*` tokens. Never tenant-controlled: surfaces,
prototype honesty strip, `--ok/--warn/--bad`, claim status chips, disabled grey. Personal / loading / failed /
invalid → neutral platform theme (#104 navy). Cache: per membership + branding version; versions not in the latest
authoritative list are evicted.

## 6. Tests and evidence

Unit (`pnpm test`): theme (validation, on-colour for 4096 colours, OD-WS1, ink, token set), context-ring (order,
ties, wrap via personal, 0/1/N), tap-arbiter (single, double, slow taps, triple/cooldown, assistive, no-gesture,
reset), context-switcher (atomic commit, delayed response dropped, rapid taps bounded, ring walk, revoked/no
auto-advance, offline+retry, cache by version + eviction, invalid theme, active revoked, capability, 0/1 start,
no health fields in loyalty), scope keys/drafts.

Playwright (`pnpm test:smoke`, production bundle): existing `smoke` + `navigation` unchanged; new
`workspace-switch` (18) and `tenant-theme` (9) — computed-colour assertions, not screenshots. Screenshots are
written to `test-results/106-*.png`; switch timing at stated synthetic conditions to
`test-results/106-switch-timing.json` (measurement only, no SLA).

Not executed here: real iOS/Android Zalo webview gesture testing (Chromium Pixel 7 emulation only); any backend,
RLS, consent or Zalo identity behaviour.

## 7. Contract gaps (proposals, NOT approved APIs)

| Gap | Need | Proposed additive shape (for a scoped follow-up) | Tests to add with it |
| --- | --- | --- | --- |
| G1 | member-channel workspace identity | `Membership.workspace {displayName, shortName, logoAssetUrl?, brandingVersion}` on `GET /v1/me/memberships`, no tenantId | schema snapshot; no internal IDs; logo via signed URL |
| G2 | service capabilities | `Membership.services[] {service: TPA_INSURANCE\|LOYALTY360, status}` | capability-filtered tiles; revoked capability hides entry |
| G3 | member read of theme | `GET /v1/me/memberships/{id}/theme` or embed `WorkspaceTheme` in G1; `ETag = brandingVersion` | invalid payload 4xx/neutral; version cache |
| G4 | Loyalty360 bounded context | personal programme + tenant programme read models (tier, points as integer string, benefits) — separate service, no insurance fields | no PII/health; per-tenant scope |
| G5 | personal profile/preferences | `GET /v1/me` additive `displayNameMasked`, `preferredMembershipId` (re-authorised) | preference ignored when not granted |
| G6 | context expiry / revocation signal | refresh flow for `MembershipContext.expiresAt`; 401/403 semantics on switch | expired → re-select; revoked → failed state |
| G7 | stable ordering | optional server `sortKey` (otherwise client vi-collation) | order stable across visits |
| G8 | hub activity pointers | capability-filtered metadata endpoint, no amounts/health | no cross-tenant bulk |
| G9 | Loyalty360 consent purposes | separate consent purpose codes/owner | not shared with TPA consent |

## 8. Open questions (owner/product)

1. Production entry: H0 hub first (recommended) vs current TPA first-run; changing it rewrites #104-tested flow.
2. Is "tenant" for Loyalty360 the same insurer workspace (current approved model) or a different org type (OD-WS4)?
   Prototype assumes the same tenant; no second tenancy hierarchy introduced.
3. Points terminology, tier names, voucher ownership and Loyalty360 consent owner — placeholders only.
4. With 1 membership the ring is personal ⇄ tenant (owner asked for the personal step); confirm that is the
   desired "no useless gesture" behaviour.
5. Theme `radius/mode/sidebarStyle` are not applied in the Mini App (light-only template); confirm.
