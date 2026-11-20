# @ottabase/ui

The Ottabase UI kit: every component the apps and package panels render, on the Design System v1 tokens. It holds the
[Radix](https://www.radix-ui.com/primitives) primitives, the Design System v1 pieces (`PageHeader`, `Stat`, `Status`,
`Tag`), the composed components built from them (`ConfirmDialog`, `MessageBox`, `DarkModeToggle`, `SplitPane`,
`JsonEditor`), the theme and brand providers, and the stylesheet with the tokens and base styles.

It started as a copy of shadcn/ui and is now its own variant: there is no upstream sync, so change the recipes here
directly. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the shadcn/ui license.

## Usage

Add the package to an app, with `next-themes` (a peer: the theme provider and `DarkModeToggle` must share the app's
copy, so the app installs it once):

```jsonc
// apps/<app>/package.json
{
    "dependencies": {
        "@ottabase/ui": "workspace:*",
        "next-themes": "catalog:",
    },
}
```

Wrap the app in the providers to get the theme (next-themes), tooltips and toasts:

```tsx
// app/providers.tsx
import { UIProviders } from '@ottabase/ui';

export function Providers({ children }: { children: React.ReactNode }) {
    return <UIProviders enableToaster>{children}</UIProviders>;
}
```

Pass `enableThemeProvider={false}` when the app already supplies its own next-themes provider higher up (otta-web does).

Use the components anywhere:

```tsx
import { Button, Card, CardContent, CardHeader } from '@ottabase/ui';

export function Example() {
    return (
        <Card>
            <CardHeader>Example</CardHeader>
            <CardContent>
                <Button>Click me</Button>
            </CardContent>
        </Card>
    );
}
```

Make Tailwind scan the package and load the stylesheet:

1. Add `'../../packages/ui/components/**/*.{js,ts,jsx,tsx}'` to the app's Tailwind `content` list.
2. Import the stylesheet in the app's global CSS, after the Tailwind base:

    ```css
    @import '@ottabase/ui-tailwind/styles/tailwind.base.css';
    @import '@ottabase/ui/styles.css';
    ```

## Entry points

| Import                          | Contents                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `@ottabase/ui`                  | Every component except `JsonEditor`, plus `cn`, `toast`, the providers and the brand override hooks |
| `@ottabase/ui/<component>`      | One component per entry (`button`, `dialog`, `confirm-dialog`, `split-pane`, …)                     |
| `@ottabase/ui/json-editor`      | `JsonEditor` and its JSON types. Kept off the root entry: it is large and few screens need it       |
| `@ottabase/ui/turnstile`        | `useTurnstile`, the Cloudflare Turnstile widget for public forms (see below)                        |
| `@ottabase/ui/providers`        | `UIProviders` and `ThemeProvider` on their own                                                      |
| `@ottabase/ui/brand-components` | The Tier-2 component override registry on its own                                                   |
| `@ottabase/ui/lib/utils`        | `cn` on its own                                                                                     |
| `@ottabase/ui/styles.css`       | Tokens (light and dark), base styles, the tone map, the focus ring, interaction physics             |

## Composed components

Built from the primitives, so they follow the tokens and the brand engine like everything else.

### ConfirmDialog

The one confirmation dialog: an `AlertDialog` with a title, an optional description and a cancel/confirm pair.

```tsx
import { Button, ConfirmDialog } from '@ottabase/ui';

<ConfirmDialog
    open={open}
    onOpenChange={setOpen}
    title="Delete post?"
    description="This action cannot be undone."
    tone="destructive"
    confirmLabel="Delete"
    onConfirm={handleDelete}
/>;

// Uncontrolled, with its own trigger
<ConfirmDialog title="Archive?" trigger={<Button variant="outline">Archive</Button>} onConfirm={archive} />;
```

- `tone`: `default`, `destructive` (solid red confirm) or `unsaved-changes` (copy defaults to leave/stay and the leave
  action comes first)
- `primaryActionText` / `secondaryActionText` win over `confirmLabel` / `cancelLabel`
- Without a `title` the dialog keeps an accessible, visually hidden one (`a11yTitle`, default `Confirm action`);
  `hideTitle` hides a given title the same way
- `contentProps`, `confirmProps`, `cancelProps` reach the underlying parts

### MessageBox

A centered status panel: one icon and one message for an empty, failed, locked or loading region. Use `Alert` for an
inline notice inside a form or card instead.

```tsx
import { MessageBox } from '@ottabase/ui';

<MessageBox message="Operation completed!" messageType="success" />
<MessageBox message={error} />                       // an Error shows as an error
<MessageBox isLoading />                             // the spinner
<MessageBox isLoading loadingType="skeleton" width={320} />
```

`messageType` is `info`, `error`, `warning`, `success`, `help`, `loginRequired`, `disconnected` or `loading`. A plain
object message is shown as formatted JSON. A numeric or CSS-length `width` is applied inline (a runtime `w-[300px]`
class would never be generated); any other string is used as a Tailwind class.

### DarkModeToggle

A theme switch on next-themes, as a switch or an icon button. The icon shows where it goes (a moon in light mode), and
flipping adds `.theming` to `<html>` for the length of the switch so every colour eases once instead of snapping.

```tsx
import { DarkModeToggle } from '@ottabase/ui';

<DarkModeToggle type="toggle-switch" />
<DarkModeToggle type="button" title="Switch theme" />
```

It needs a next-themes provider above it (`UIProviders`, `ThemeProvider`, or the app's own).

### SplitPane

Two resizable panes, side by side or stacked. Drag or use the keyboard on the divider (arrows step 1% or 10px, Home/End
jump to the bounds); it reports itself as a `separator` with its current value.

```tsx
import { SplitPane } from '@ottabase/ui';

<SplitPane split="vertical" defaultSize="30%" minWidth={200} onChange={setSize}>
    <Sidebar />
    <SplitPane split="horizontal" defaultSize={240} snapPoints={[120, 240, 360]}>
        <Editor />
        <Console />
    </SplitPane>
</SplitPane>;
```

| Prop                                                   | Default      | Description                                       |
| ------------------------------------------------------ | ------------ | ------------------------------------------------- |
| `split`                                                | `'vertical'` | `'vertical'` (left/right) or `'horizontal'`       |
| `defaultSize`                                          | `'50%'`      | First pane size: `'30%'`, `'200px'` or `200` (px) |
| `minWidth` / `maxWidth`                                | `50` / none  | Bounds in px for a vertical split                 |
| `minHeight` / `maxHeight`                              | `50` / none  | Bounds in px for a horizontal split               |
| `snapPoints` / `snapThreshold`                         | `[]` / `20`  | Pixel positions to snap to, and how close counts  |
| `onChange`                                             | none         | Called with the new size                          |
| `className` / `resizerClassName`                       | none         | Classes for the container and the divider         |
| `style` / `pane1Style` / `pane2Style` / `resizerStyle` | none         | Inline style overrides                            |

Reach for `ResizablePanelGroup` (react-resizable-panels) when you need more than two panes or persisted layouts.

### JsonEditor

A dual-mode JSON editor with no external editor dependency: a Tree mode with inline key and value editing, type
switching and add/remove, and a Raw mode with live validation and format/minify.

```tsx
import { JsonEditor, type JsonValue } from '@ottabase/ui/json-editor';

const [value, setValue] = useState<JsonValue>({ hello: 'world', count: 1 });

<JsonEditor value={value} onChange={setValue} rootLabel="meta" collapseAtDepth={3} />;
```

Props: `value`, `onChange`, `readOnly`, `defaultMode` (`'tree' | 'raw'`), `collapseAtDepth`, `rootLabel`, `className`.
`Enter` commits an inline edit and `Escape` cancels; in Raw mode `Ctrl/Cmd+S` formats. `@ottabase/forms` uses it for
`fieldType: 'json'` fields and the blog editor for its Custom Meta tab: use it rather than adding a JSON editor
dependency.

## Turnstile

The browser side of Cloudflare's bot check, for forms a stranger can submit. One hook per form:

```tsx
import { useTurnstile } from '@ottabase/ui/turnstile';

const human = useTurnstile('register'); // the action the route checks
// in the form, above the submit button (null when bot checks are off):
{
    human.widget;
}
// on submit, once per request:
await fetch('/api/auth/register', {
    method: 'POST',
    headers: { ...(await human.headers()), 'Content-Type': 'application/json' },
    body,
});
```

The widget is invisible for most people and shows a challenge only when Cloudflare wants one (`appearance: 'always'`
shows it regardless). `headers()` waits for the token, hands it over once (tokens are single use) and readies the next
one. The script loads once per page; the widget follows the page's `lang` and its `.dark` / `.light` class. The site key
comes from `configureTurnstile({ siteKey })`, else `<meta name="turnstile-site-key">` (otta-web's Worker adds it to
every document when the keys are set), else the hook's `siteKey` option. Without one nothing renders and `headers()` is
empty. The server checks the header with `requireHuman` from `@ottabase/cf/turnstile`.

## Design System v1 pieces

The recipes implement Ottabase Design System v1 (`docs/DESIGN_SYSTEM.md`). Beyond the primitives, the package ships the
record-level pieces the admin and every package panel share:

```tsx
import { Status, Tag, EnvName, PageHeader, Stat, Button } from '@ottabase/ui';

<PageHeader title="Vault" description="Backups to R2, restore, per-tenant export." actions={<Button>Run backup</Button>} />
<Stat label="Backups kept" value={3} unit=" of 5" foot="newest 9h ago" />
<Status domain="license" value="grace" withIcon />   // tone, label and icon from the one status map
<Tag mono>v1.0.0</Tag> <EnvName>PREMIUM_LICENSE_VAULT</EnvName>
<Button variant="danger">Remove app</Button>        // outline in place; `destructive` (solid) only inside a confirm
<Button loading>Run backup</Button>                 // the one spinner
```

Tones are a CSS map: any element with `data-tone="green|amber|red|blue|smoke|neutral|brand"` can read `--t-fg`,
`--t-bg`, `--t-line` and `--t-solid`. Code and CLI output sit in the always-dark `terminal` room:
`<BrandScope name="terminal">` or `data-brand-scope="terminal"`.

## Data display

```tsx
import {
    Timeline, TimelineItem, TimelineHeader, TimelineTitle, TimelineTime, TimelineDescription,
    TreeView, type TreeNode, AvatarGroup, Avatar, AvatarFallback, Rating, VisuallyHidden,
} from '@ottabase/ui';

<Timeline aria-label="Recent events">
    <TimelineItem tone="red" icon={X}>
        <TimelineHeader>
            <TimelineTitle>job.failed</TimelineTitle>
            <TimelineTime dateTime="2026-10-24T09:41:00Z">09:41 UTC</TimelineTime>
        </TimelineHeader>
        <TimelineDescription>email.send moved to the dead-letter queue</TimelineDescription>
    </TimelineItem>
</Timeline>

<TreeView aria-label="Admin" items={nodes} defaultExpanded={['content']} selected={id} onSelectedChange={setId} />
<AvatarGroup max={4} total={members.length} aria-label="Members">{members.map(…<Avatar>…)}</AvatarGroup>
<Rating aria-label="Your rating" value={stars} onValueChange={setStars} step={0.5} />
<Rating readOnly value={4.3} aria-label="Average rating" />
<Button size="icon"><X /><VisuallyHidden>Close</VisuallyHidden></Button>
```

- **Timeline** is the Design System's event rail (`ob-tl`), an `<ol>`. A marker is a ringed dot, or a soft disc with
  `icon`; only an event that needs someone takes a `tone`. Items are subgrid rows, so dots and discs mixed in one list
  keep one straight rail. Give `TimelineTime` a `dateTime`.
- **TreeView** is the WAI-ARIA tree pattern rendered flat: one tab stop, Up/Down, Right opens or steps in, Left closes
  or steps out, Home/End, Enter selects and toggles, Space selects, typed letters jump (the same letter cycles). A click
  selects, the chevron or a double click opens. `expanded` and `selected` are controlled or not (`default*`);
  `selectable={false}` makes a reading tree; `renderItem` adds a count or a badge; a `disabled` node stays focusable but
  cannot be selected or opened. Indent guides are drawn per row, a hairline per ancestor.
- **AvatarGroup** overlaps its avatars (ringed in the surface colour), folds everything past `max` into "+N" (from
  `total` when only some are loaded) and sizes its children (`sm` 24px, `default` 32px, `lg` 40px). Pass plain
  `<Avatar>`s as its only children.
- **Rating** is the WAI-ARIA rating slider when interactive: arrows step by `step` (1 or 0.5, the pointer picks halves
  too), Home clears, End is the top mark, a digit jumps, hovering previews and clicking the current value clears it
  (`allowClear`). Read-only it is an image whose label carries the value, and fractions fill as they are. Stars read
  `--rating-color` (amber by default); `max`, `size`, `name` (form value) and `getValueText` (what a screen reader
  hears) are props. The mark is any SVG: `icon` takes a Lucide icon, your own SVG component (it must pass `className` to
  its `<svg>`) or an `<svg>` element, and `emptyIcon` draws the empty part with a shape of its own. Halves and fractions
  work for every mark (a filled copy is clipped over the empty one). A path with no fill takes the rating's colours, one
  in `currentColor` follows the theme, and a fixed fill is kept for multicolour marks.
- **VisuallyHidden** keeps text for screen readers only (`sr-only`); `asChild` hides your own element.

## Input building blocks

`NumberInput`, `PasswordInput`, `FileInput` and `ColorInput` are on the root and on their own entries
(`@ottabase/ui/number-input`, …). Each forwards its ref to the native `<input>` and stamps `data-slot` parts.

```tsx
import { ColorInput, FileInput, NumberInput, PasswordInput, Slider, Textarea } from '@ottabase/ui';

// Number: typed as text (inputMode="decimal"), value is number | null
<NumberInput value={price} onChange={setPrice} min={0} max={10_000} step={0.5} decimalScale={2}
    prefix="$" thousandSeparator name="price" />
<NumberInput value={ms} onChange={(v) => setMs(v ?? 0)} min={0} decimalScale={0} suffix="ms" hideControls />

// Password: reveal toggle, opt-in rule checklist (true = passwordRequirements(minLength ?? 8))
<PasswordInput id="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" requirements />
<PasswordInput requirements={[{ label: 'No spaces', test: (p) => !/\s/.test(p) }]} />

// File: click-to-choose box; maxSize refuses with a message; previews a picked image
<FileInput accept="image/*" maxSize={2 * 1024 * 1024} imagePreview onChange={([file]) => upload(file)} onClear={reset} />
<FileInput multiple loading={uploading} error={uploadError} previewUrl={savedUrl} />

// Color: swatch + native picker + hex text; value is '#rrggbb' | null
<ColorInput value={accent} onChange={setAccent} swatches={['#0ea5e9', '#22c55e', '#f97316']} clearable />

// Range slider: one thumb per value
<Slider defaultValue={[20, 80]} thumbLabels={['Minimum', 'Maximum']} />

// Textarea that grows with its content (CSS field-sizing, no JS)
<Textarea autosize minRows={2} maxRows={8} />
```

- **NumberInput** keeps what you type while you edit: a number in range applies as typed, leaving the field (or Enter)
  clamps the rest (`clampOnBlur`, default on). ArrowUp/ArrowDown step (Shift ×10); the stepper buttons are mouse-only
  (`hideControls` hides them). `allowNegative` defaults to `min < 0`. `name` writes the plain number to a hidden input,
  so a native form posts `1234.5`, never `$1,234.50`. With react-hook-form use a `Controller` (the value is a number,
  not an event). `className` styles the box, `inputClassName` the text field.
- **PasswordInput**'s toggle is a pressed-state button named "Show password". The checklist (`requirements`) appears
  once something is typed and is linked to the field with `aria-describedby`.
- **FileInput**'s native input sits inside the box, visually hidden but focusable, so keyboard and screen readers get
  the platform picker. `previewUrl` overrides the automatic preview (sanitise untrusted URLs); the remove button shows
  only with `onClear`. Uploading stays with the caller (`@ottabase/forms` FormField does it for `file`/`image` fields).
- **ColorInput** accepts `#abc`, `abc` or `#aabbcc` and emits lowercase `#rrggbb`; invalid text is flagged
  (`aria-invalid`) and reverts on blur. Hex only.
- **Checkbox** with `checked="indeterminate"` shows a dash.

## Display building blocks

```tsx
import {
    DataList, DataListItem, DataListLabel, DataListValue, LoadingOverlay, Indicator, Avatar, AvatarFallback,
    Highlight, ShowMore, OverflowList, Tag, TableOfContents, DiffView,
} from '@ottabase/ui';

<DataList orientation="vertical" className="sm:grid-cols-2">
    <DataListItem>
        <DataListLabel>Release</DataListLabel>
        <DataListValue>1.4.2</DataListValue>
    </DataListItem>
</DataList>

<div className="relative" aria-busy={saving}>
    <Form />
    <LoadingOverlay visible={saving} label="Saving…" />
</div>

<Indicator count={unread} indicatorLabel={`${unread} unread`}>
    <Avatar><AvatarFallback>DT</AvatarFallback></Avatar>
</Indicator>
<Indicator tone="green" processing position="bottom-end" offset={4}><Avatar>…</Avatar></Indicator>

<Highlight highlight={query}>{item.name}</Highlight>

<ShowMore maxHeight={160}><pre>{alert.body}</pre></ShowMore>

<OverflowList items={tags} className="gap-1.5" renderItem={(tag) => <Tag>{tag}</Tag>} />

<TableOfContents items={[{ id: 'setup', label: 'Setup', depth: 2 }]} selector=".prose h2, .prose h3" title="On this page" />

<DiffView before={{ name: 'Old', plan: 'pro' }} after={{ name: 'New', plan: 'pro' }} />  // field diff
<DiffView before={oldText} after={newText} />                                            // line diff
<DiffView parts={diffWords(oldText, newText)} />                                         // your own word diff
```

- **DataList** is a `<dl>`: `orientation="horizontal"` (default) puts labels in their own column (each item a subgrid
  row, so values line up); `vertical` stacks label over value. `size` is `sm` or `default`. A server component.
- **LoadingOverlay** covers its `relative` parent: content stays visible, dimmed and blurred, under a spinner and an
  optional `label`. It is a polite `role="status"`; mark the covered region `aria-busy`. `visible={false}` renders
  nothing; `blur={false}` only dims. Its root is a `<span>`, so it is valid inside a button.
- **Indicator** pins a dot (no `label`/`count`) or a mark to a corner of its child: `count` caps at `max` ("99+") and
  hides at zero unless `showZero`; `position` is `top-end` (default), `top-start`, `bottom-end` or `bottom-start`;
  `offset` moves it in from the corner (round children); `tone` reads the tone map; `processing` pulses (still under
  reduced motion); `disabled` hides it; `indicatorLabel` is what a screen reader hears.
- **Highlight** wraps case-insensitive matches of `highlight` (a string or several) in `<mark>`; regex characters are
  literal. `highlightClassName` restyles the marks (`bg-transparent font-semibold` in a picker list).
- **ShowMore** clamps content to `maxHeight` px with a fade and shows "Show more" / "Show less" only when the content is
  taller. `expanded`/`defaultExpanded`/`onExpandedChange`, `showLabel`/`hideLabel`. (The blur-to-reveal `Spoiler` in
  `@ottabase/ottarenderer` is a different thing.)
- **OverflowList** renders as many items as fit on one line, measured with real widths and re-fitted on resize, then
  `renderOverflow(hidden)` (default a "+N" `CountBadge`). `minVisible` keeps some items regardless. Every item shows
  until the row has a width (server render, tests).
- **TableOfContents** lists `{ id, label, depth }` links. Pass `activeId`, or a `selector` for the headings and it
  follows the scroll itself (`useScrollSpy`; `rescanKey` re-scans for a new document). A click scrolls (smoothly unless
  the OS asks for reduced motion) and replaces the URL hash without the router seeing a navigation, then calls
  `onItemClick`; Ctrl/Cmd/middle clicks open the link as usual. `unstyled` drops the Tailwind look so your CSS can style
  the parts (`toc`, `toc-title`, `toc-list`, `toc-item`, `toc-link` with `data-active` and a `--toc-depth` variable);
  `@ottabase/docs` and `@ottabase/legal` do that.
- **DiffView** is a read-only before/after. Two objects give a field diff (added, removed, `old → new`; nested values as
  compact JSON, compared deeply; `showUnchanged` lists the rest). Two strings give a line diff (a built-in LCS, no
  dependency; CRLF counts as LF and a final newline is not an extra line). `parts` takes changes you computed, in the
  `diff` package's `{ value, added?, removed? }` shape, for a word-level diff of prose. `diffFields` and `diffLines` are
  exported too. The admin audit log shows `changes` with it.

## Theming hooks (Brand Engine)

Components are fully themeable by the brand engine without forking:

- **`data-slot` everywhere**: every primitive stamps `data-slot="button"`, `data-slot="dialog-content"`, and so on; CVA
  components also stamp `data-variant`/`data-size`. Because brand stylesheets are injected after the bundle, theme CSS
  restyles anything at equal specificity:

    ```css
    [data-slot='button'][data-variant='outline']:hover {
        border-color: var(--link);
    }
    ```

- **Global focus ring**: components carry no per-component `focus-visible:ring-*` recipes; one global rule in
  `styles/ui.css` reads `--focus-ring-{width,style,color,offset}`. Text-entry surfaces (`Input`, `Textarea`,
  `NativeSelect`, `SelectTrigger`, `InputGroup`, the active `InputOTPSlot`, the calendar's dropdowns) instead take a
  focus-coloured edge and a 3px halo from one shared rule, red when `aria-invalid="true"`. That rule sits in the
  utilities layer so the fields' own border and shadow utilities cannot hide it; a theme restyles it from
  `[data-slot=…]:focus`.
- **Native fallbacks follow the brand**: without theme overrides, `accent-color` is the primary and `::selection` is a
  soft wash of the focus colour, never the browser's blue.
- **Interaction physics**: interactive elements use bare `transition`, so `--hover-transform` / `--press-transform` /
  `--press-shadow` tokens animate hover-lift and press states globally. Opt any custom element in with `data-press`.
- **Decor carriers**: `Button` and `Card` render an empty `aria-hidden` `[data-decor]` span (hidden by default) that
  theme CSS can enable for shine sweeps, ornaments or texture layers.
- **Scrims**: overlays use the `--overlay` color token (`bg-overlay/80`), not hardcoded black.
- **Token rooms**: wrap a subtree in `<BrandScope name="afterdark">…</BrandScope>` (or put `data-brand-scope` on any
  element) and every child re-reads the re-bound semantic vars for that room. No dark-mode props needed.
- **Tier-2 component overrides**: when a design system needs genuinely different DOM, register replacements:

    ```tsx
    import { BrandComponentsProvider } from '@ottabase/ui';

    <BrandComponentsProvider overrides={{ button: UppButton }}>{children}</BrandComponentsProvider>;
    ```

    `button`, `badge`, `card` and `input` resolve overrides from context, receiving their original props. Prefer the CSS
    path; reserve overrides for DOM-level differences. These primitives declare explicit React client boundaries because
    resolving an override reads context; the package build preserves those directives for Next.js/RSC consumers.

## Hooks

Generic DOM hooks, on the root entry and on `@ottabase/ui/hooks`. Reach for them before writing a `useEffect` with a
document listener, a `setTimeout` debounce or raw `localStorage`.

```tsx
import {
    CopyButton,
    useClickOutside,
    useDebouncedCallback,
    useHotkeys,
    useLocalStorage,
    useMediaQuery,
} from '@ottabase/ui';
import { useRef, useState } from 'react';

export function Toolbar({ onSearch }: { onSearch: (term: string) => void }) {
    const [open, setOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);
    const [density, setDensity] = useLocalStorage<'compact' | 'comfortable'>('app.density', 'comfortable');
    const isMobile = useMediaQuery('(max-width: 767px)');
    const search = useDebouncedCallback(onSearch, 300);

    useClickOutside(menuRef, () => setOpen(false), open); // listens only while open
    useHotkeys([
        ['mod+k', () => setOpen(true)],
        ['escape', () => setOpen(false)],
    ]);

    return (
        <div ref={menuRef} data-density={density}>
            <input onChange={(e) => search(e.target.value)} />
            {!isMobile && <CopyButton value="ok_live_123" label="API key" notify />}
            <button onClick={() => setDensity('compact')}>Compact</button>
        </div>
    );
}
```

- `useLocalStorage` stores JSON and syncs every hook on the key, across tabs too; `getStorageValue` / `setStorageValue`
  do the same outside React. Setting `undefined` removes the key.
- `useHotkeys` skips single-key shortcuts while typing in a field; `mod` shortcuts (Cmd or Ctrl) still fire there.
- Also: `useClipboard` (custom copy UI), `useDebouncedValue`, `useReducedMotion`, `useElementSize`, `useMergedRef`,
  `useScrollSpy`, `useLatest`, `parseShortcut`, `isEditableTarget`.

## Base styles

`styles/ui.css` also carries the few base rules Tailwind's reset leaves out: the body fills the viewport, the app root
(`#root`, `#__next`) is its own stacking context so portals stack above it, long words and URLs wrap in paragraphs and
headings, German and French text hyphenates, and in-page anchors scroll smoothly unless the person asked for reduced
motion.

## Development

```bash
pnpm --filter @ottabase/ui build
pnpm --filter @ottabase/ui lint
pnpm --filter @ottabase/ui type-check
pnpm --filter @ottabase/ui test
```

Components live in `components/ui/` (one file each, kebab-case) and are built one entry per file so `'use client'` stays
at the top of each. A component that holds state or effects starts with `'use client'`; the client-boundary test checks
the ones that must. Stories live in `stories/`.
