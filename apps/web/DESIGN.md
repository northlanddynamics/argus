---
name: Argus
description: Collaborative security case management for in-house teams; a quiet, dense, all-day working tool in light and dark mode.
colors:
  background: "oklch(1 0 0)"
  foreground: "oklch(0.145 0 0)"
  primary: "oklch(0.205 0 0)"
  primary-foreground: "oklch(0.985 0 0)"
  muted: "oklch(0.97 0 0)"
  muted-foreground: "oklch(0.556 0 0)"
  border: "oklch(0.922 0 0)"
  ring: "oklch(0.708 0 0)"
  sidebar: "oklch(0.985 0 0)"
  destructive: "oklch(0.577 0.245 27.325)"
  notice-surface: "oklch(0.987 0.022 95.277)"
  notice-border: "oklch(0.879 0.169 91.605)"
  notice-ink: "oklch(0.279 0.077 45.635)"
  live: "oklch(0.723 0.219 149.579)"
  reconnecting: "oklch(0.769 0.188 70.08)"
  overdue-ink: "oklch(0.505 0.213 27.518)"
  overdue-border: "oklch(0.808 0.114 19.571)"
  mention-surface: "oklch(0.951 0.026 236.824)"
  mention-ink: "oklch(0.391 0.09 240.876)"
  operator-chrome: "oklch(0.208 0.042 265.755)"
typography:
  headline:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: "2rem"
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "1rem"
    fontWeight: 500
    lineHeight: "1.5rem"
  body:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: "1.25rem"
  label:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: "1rem"
  reference:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: "1rem"
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
  pill: "26px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
  button-outline:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
  button-ghost:
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
  button-destructive:
    textColor: "{colors.destructive}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
  input:
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    padding: "4px 10px"
    height: "32px"
  badge-solid:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.pill}"
    padding: "2px 8px"
    height: "20px"
  badge-outline:
    textColor: "{colors.foreground}"
    rounded: "{rounded.pill}"
    padding: "2px 8px"
    height: "20px"
  card:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.xl}"
    padding: "16px"
  notice:
    backgroundColor: "{colors.notice-surface}"
    textColor: "{colors.notice-ink}"
    rounded: "{rounded.lg}"
    padding: "8px 10px"
---

# Design System: Argus

## Overview

**Creative North Star: "The Quiet Console"**

Argus is a working tool that Analysts keep open all day, and the design stays out of their way. Surfaces are neutral (white in light mode, near-black in dark mode), and the things that stand out most are those that need attention: a warning, an error, an overdue Task, the live connection, and the people on the Case with you. Colour may also be used decoratively, sparingly and with taste, where it makes the tool more pleasant without competing with those signals. Density is high. Body text is 14px, controls are 32px tall, and the standard gap is 8px, so a Case, its Tasks and its Alerts fit on one desktop screen without scrolling around.

The system is shadcn/ui ("radix-nova" style, neutral base colour) kept close to stock on purpose. Buttons, inputs, menus, dialogs, tables and the sidebar behave the way people expect from any modern web app, and no part of the interface needs learning. Argus's own character shows in a few domain markers: Severity shown by badge weight, the dashed "Internal" badge, monospace Case references, the live-status dot and tinted presence avatars.

The app supports light and dark mode. By default it follows the device's setting; anyone can choose System, Light or Dark under Theme in the account menu (remembered per browser, via `next-themes` with the `.dark` class). Both themes come from the same tokens in `src/index.css`, so every surface and signal colour has a light and a dark value.

**Key Characteristics:**
- Neutral greyscale surfaces in light and dark mode; colour mainly signals what needs attention, with occasional tasteful decoration.
- Dense: 14px body, 32px controls, 8px default gap.
- Stock shadcn/ui components with no custom styling of their own.
- Flat: hairline borders and rings rather than shadows.
- Domain meaning carried by weight, outline and pattern (solid, heavy, dashed) as well as colour.

## Colors

A neutral greyscale working surface in both themes, a small set of signal colours that each mean one thing, and room for a little decorative colour.

The frontmatter lists the light-mode values. Every token also has a dark-mode value under `.dark` in `src/index.css`; signal colours are tokens (`bg-notice`, `text-overdue`, `bg-mention` and so on), never raw Tailwind palette classes, so they switch with the theme.

### Primary
- **Ink Black** (primary): primary buttons, Critical Severity badges, active selections. A near-black neutral, not a brand hue; the strongest emphasis the UI has.

### Neutral
- **Paper White** (background): the page, cards and popovers.
- **Console Ink** (foreground): all body text and headings.
- **Soft Grey Wash** (muted): hover fills, secondary buttons, code and backup-code wells.
- **Quiet Grey Text** (muted-foreground): secondary text, metadata, Case references, "Visible to Guests".
- **Hairline Grey** (border): every border, divider and input stroke.
- **Focus Grey** (ring): the focus ring, drawn at 50% opacity.
- **Sidebar Mist** (sidebar): the left sidebar, a step off white.

### Signal colours
- **Alarm Red** (destructive): errors, destructive actions (shown as a 10% tint behind red text) and inline `role="alert"` messages.
- **Amber Notice** (notice-surface, notice-border, notice-ink): the one warning treatment, for "this changed since you saw it", partly applied bulk actions, and confirmations with consequences (closing a Case, write-back settings).
- **Live Green** (live) and **Reconnecting Amber** (reconnecting): the status dot beside the live-connection label.
- **Overdue Red** (overdue-ink, overdue-border): the overdue Task badge.
- **Mention Blue** (mention-surface, mention-ink): @mentions highlighted inside Discussion messages.
- **Presence tints** (sky, amber, emerald, rose, violet and lime at Tailwind's 200 step): avatar backgrounds, chosen from each person's id so the same person always gets the same tint. They keep the same pastel and dark initials in both themes.

### Decorative colour
Decorative colour is allowed: a tint behind an empty state, a coloured icon, an accent on a sign-in page or a chart. Use it sparingly, so a working screen still reads as neutral at a glance, and never in a hue or strength that could be mistaken for a signal above (amber reads as a warning, red as an error).
- **Operator Slate** (operator-chrome): the header of the Operator console only, which marks it as a different place from an Organization's workspace.

### Named Rules
**The Attention Rule.** Colour's first job is to draw attention to something the person should notice: a warning, an error, something overdue, a connection state, another person. A neutral surface is the default.

**The Sparing Decoration Rule.** Decorative colour is welcome when it is sparing and tasteful: a small touch per screen, soft in strength, and never louder than a signal colour or confusable with one.

**The Both Themes Rule.** Every colour is a token with a light and a dark value. A colour that only works in one theme isn't finished.

**The One Amber Rule.** Every warning uses the same Amber Notice treatment (amber-300 border, amber-50 fill, amber-950 text). Don't invent a second warning style.

## Typography

**Body Font:** Geist Variable (with sans-serif)
**Label/Mono Font:** the system monospace stack, for references, hashes and keys

**Character:** One neutral sans-serif throughout, with hierarchy from size and weight rather than a second family. Monospace marks values that are identifiers, not prose.

### Hierarchy
- **Headline** (600, 1.5rem, 2rem line-height, -0.025em tracking): the page `h1` (Cases, Search, a Case's title) and auth card titles.
- **Title** (500, 1rem): card titles and section headings.
- **Body** (400, 0.875rem, 1.25rem line-height): everything else: tables, forms, Discussion, menus. Inputs are 1rem on narrow screens and 0.875rem from `md` up, which stops iOS zooming in on focus.
- **Label** (500, 0.75rem): badges, metadata lines, the live indicator, small buttons.
- **Reference** (mono, 0.75rem, muted): Case references such as "C-12", Evidence fingerprints, Observable values, TOTP keys and backup codes.

### Named Rules
**The Two Sizes Rule.** Working screens are set almost entirely in 14px body and 12px label. Larger sizes are for the page heading only.

**The Identifier Rule.** Anything a person might copy, compare or search for exactly (references, hashes, IPs, keys) is set in monospace.

## Layout

The app frame is shadcn's sidebar layout: a 350px left sidebar (collapsible, its state remembered in the `sidebar_state` cookie) and a content inset with a sticky 56px header. The header holds the sidebar toggle, the breadcrumb trail (Organization / Cases / C-12 / Tasks), the search box, the notification bell and the live indicator.

Every page in the app frame is left-aligned in the content inset, so the breadcrumb, the page heading and the first column share one edge on every page, and spare width on a large monitor falls to the right. Each page takes the width its content earns:

- **Tables and queues** (Cases, a Case, Alerts, Observable and Asset pages, the Dashboard) grow up to 1920px (`max-w-page`, the `--container-page` token in `src/index.css`). A table given more room shows more, not the same thing spread wider: it reveals columns through container queries (the Cases list gives Case Type, Alerts and Opened their own columns from `@6xl`), or sets fixed column widths and lets the last column take the slack, so a row's actions stay beside what they act on (Tasks from `@7xl`).
- **Reading lists and forms** stay narrow inside them: Search results 1024px (`max-w-5xl`), the Bulk Lookup form 1024px (its results table uses the page width), the Observable and Asset add rows 768px (`max-w-3xl`), and the Case header's four fields at most 18rem each. Settings stays at 1152px (`max-w-6xl`) and Guest home at 768px.
- **Prose** keeps a 75ch measure (the Case Summary editor sets it on each block). A Case's Overview puts the Case Summary, the open Tasks and the rail in three columns only once it is 104rem wide, where the open Tasks have room for their titles.

Dialogs use 672px (`max-w-2xl`) or less. Spacing follows Tailwind's 4px scale, almost entirely in four steps: 4px (tight inline pairs), 8px (the default gap between controls and rows), 12px, and 16px (between page sections and card padding). Sign-in, invitation and Guest sign-in pages centre a single card on the page.

The layout is built and checked on desktop. The sidebar collapses to a sheet on small screens (shadcn default), but no other responsive behaviour is designed.

## Elevation & Depth

Flat. In dark mode, cards and popovers sit one step lighter than the page (`card` over `background`) instead of relying on shadows. Surfaces sit on the page with a hairline: cards use a 1px ring of foreground at 10%, and panels use the border grey. Shadows appear only on things floating above the page, such as menus, popovers, the mention picker, toasts and dialogs. They use shadcn's defaults (`shadow-sm` to `shadow-lg`) and are never used to emphasise content.

### Named Rules
**The Float-Only Shadow Rule.** A shadow means "this is floating above the page". Content in the page flow never gets one.

## Shapes

Gently rounded throughout from one base radius of 10px (`--radius: 0.625rem`): buttons, inputs and notices at 10px, small buttons at 8px, cards at 14px, and badges fully pill-shaped. Avatars and status dots are circles. Borders are 1px, except the High Severity badge's 2px outline and the Internal badge's dashed one, where the border itself carries meaning.

## Components

Familiar and unremarkable: stock shadcn/ui, added with `bunx shadcn@latest add` and never restyled locally.

### Buttons
- **Shape:** gently rounded (10px), 32px tall, 10px horizontal padding; `sm` is 28px and `xs` 24px.
- **Primary:** Ink Black fill with white text; one per view, for the main action.
- **Outline / Ghost / Secondary:** white with hairline border, transparent, and grey wash. Hover fills with Soft Grey Wash.
- **Destructive:** red text on a 10% red tint, never a solid red fill.
- **Hover / Focus:** primary fades to 80% on hover; focus shows a 3px ring of Focus Grey at 50%; pressing nudges the button down 1px.

### Chips (badges)
- **Style:** pill-shaped, 20px tall, 12px medium text.
- **Severity:** Critical is a solid Ink Black badge, High a 2px foreground outline in semibold, and Medium, Low and Informational a thin outline. Severity is shown in greyscale by weight, not by colour.
- **Status:** a thin outline; a Closed Case reads "Closed · Benign".
- **Internal:** a dashed outline at 50% foreground, the marker for anything hidden from Guests.
- **Overdue:** a thin outline in Overdue Red.
- **Access:** a thin outline with its icon and the words: a lock and "Restricted", people and "2 Guests".
- **Tag:** the secondary (grey-fill) pill, "#bec".

### Cards / Containers
- **Corner Style:** 14px.
- **Background:** Paper White.
- **Shadow Strategy:** none (see Elevation & Depth).
- **Border:** a 1px ring of foreground at 10%.
- **Internal Padding:** 16px, or 12px for the small size.

### Inputs / Fields
- **Style:** 32px tall, 10px radius, hairline border, transparent fill, muted placeholder.
- **Focus:** the border turns Focus Grey with a 3px ring at 50%.
- **Error / Disabled:** `aria-invalid` turns the border red with a faint red ring; disabled fields fade to 50%.

### Navigation
- **Sidebar:** shadcn's sidebar in Sidebar Mist: an icon rail, then the work queue. The queue splits open Cases into Assigned to me, Assigned to others and Unassigned; each Member can hide, collapse, sort (Severity or last change) and reorder the sections, remembered per browser. The open Case is a white row with a hairline ring, and rows flash briefly when they change live but hold still under the pointer. It collapses, and the choice is remembered; it starts collapsed in Settings and the Dashboard.
- **Breadcrumbs:** in the sticky header. The Organization name is medium weight; links are muted until hovered, and the current page is in foreground.

### Notices
- **Style:** shadcn's `Alert` in the Amber Notice treatment, placed inline where the problem is (in the dialog, above the table) rather than as a toast.

### Live indicator
- An 8px status dot beside a 12px muted label: grey "Connecting…", Live Green "Live", Reconnecting Amber "Reconnecting…", and green "Reconnected · views refreshed". The label always says the state in words, so it never depends on the dot's colour.

### Presence avatars
- Circular avatars with 11px semibold initials in Slate ink on a tint picked from each person's id. Each is focusable and named for screen readers.

## Do's and Don'ts

### Do:
- **Do** use stock shadcn/ui components and add new ones with `bunx shadcn@latest add`.
- **Do** keep working screens at 14px body and 12px label, with 32px controls and 8px gaps.
- **Do** use the existing signal colour for its meaning (warnings, errors, overdue, live state, mentions, people).
- **Do** use decorative colour sparingly and tastefully, softer than any signal colour.
- **Do** define every new colour as a token with light and dark values in `src/index.css`, and check the screen in both themes.
- **Do** put every warning in the Amber Notice style, inline next to what it is about.
- **Do** set references, hashes, IPs and keys in monospace.
- **Do** pair every colour signal with words or a shape (a label, a dashed or heavy outline) so it never relies on colour alone.

### Don't:
- **Don't** restyle shadcn/ui components locally or add custom variants for one screen.
- **Don't** put shadows on content in the page flow; they are only for menus, popovers, toasts and dialogs.
- **Don't** let decorative colour dominate a working screen, or use amber or red decoratively where it could be read as a warning or error.
- **Don't** use raw Tailwind palette classes (`bg-amber-50`, `text-red-700`) for anything that must work in both themes; use a token.
- **Don't** use a solid red fill for destructive buttons; use the red-tint destructive variant.
- **Don't** create a second warning style next to Amber Notice.
