/**
 * The newer building blocks of @ottabase/ui: the extra inputs, the small display pieces,
 * CopyButton and the shared DOM hooks. The Slider range, the indeterminate Checkbox and Textarea
 * autosize sit in Forms & Inputs; the ottadate React pickers have their own page at /demo/ottadate.
 */
import {
    Avatar,
    AvatarFallback,
    Button,
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    ColorInput,
    CopyButton,
    DataList,
    DataListItem,
    DataListLabel,
    DataListValue,
    DiffView,
    FileInput,
    Highlight,
    Indicator,
    Input,
    Kbd,
    Label,
    LoadingOverlay,
    NumberInput,
    OverflowList,
    PasswordInput,
    ShowMore,
    TableOfContents,
    Tag,
    useClickOutside,
    useDebouncedValue,
    useElementSize,
    useHotkeys,
    useLocalStorage,
    useMediaQuery,
} from '@ottabase/ui';
import { Bell } from 'lucide-react';
import { useRef, useState } from 'react';

const TAGS = ['workers', 'd1', 'r2', 'queues', 'durable-objects', 'kv', 'vectorize', 'analytics-engine', 'ai'];

const TOC_ITEMS = [
    { id: 'bb-inputs', label: 'Inputs', depth: 1 },
    { id: 'bb-display', label: 'Display', depth: 1 },
    { id: 'bb-diff', label: 'DiffView', depth: 2 },
    { id: 'bb-hooks', label: 'Hooks', depth: 1 },
];

function InputsCard() {
    const [amount, setAmount] = useState<number | null>(1250);
    const [color, setColor] = useState<string | null>('#2f9e6f');
    const [files, setFiles] = useState<File[]>([]);

    return (
        <Card>
            <CardHeader>
                <CardTitle id="bb-inputs" className="scroll-mt-24">
                    Inputs
                </CardTitle>
                <CardDescription>NumberInput, PasswordInput, FileInput and ColorInput.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-6 md:grid-cols-2">
                <div className="grid gap-2">
                    <Label htmlFor="bb-amount">NumberInput (prefix, thousands, 0–1,000,000)</Label>
                    <NumberInput
                        id="bb-amount"
                        value={amount}
                        onChange={setAmount}
                        min={0}
                        max={1_000_000}
                        step={50}
                        decimalScale={2}
                        thousandSeparator
                        prefix="$"
                    />
                    <p className="text-xs text-muted-foreground">
                        Value: <code>{String(amount)}</code>. Arrow keys step, Shift steps ×10.
                    </p>
                </div>

                <div className="grid gap-2">
                    <Label htmlFor="bb-password">PasswordInput (with requirements)</Label>
                    <PasswordInput id="bb-password" placeholder="Choose a password" requirements />
                </div>

                <div className="grid gap-2">
                    <Label htmlFor="bb-color">ColorInput (hex)</Label>
                    <ColorInput
                        id="bb-color"
                        value={color}
                        onChange={setColor}
                        clearable
                        swatches={['#2f9e6f', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6']}
                    />
                </div>

                <div className="grid gap-2">
                    <Label>FileInput (images, 2 MB max)</Label>
                    <FileInput
                        accept="image/*"
                        maxSize={2 * 1024 * 1024}
                        imagePreview
                        onChange={setFiles}
                        onClear={() => setFiles([])}
                        hint={files.length ? `${files.length} file selected` : 'PNG, JPG or SVG'}
                    />
                </div>
            </CardContent>
        </Card>
    );
}

function DisplayCard() {
    const [busy, setBusy] = useState(true);
    const [query, setQuery] = useState('edge');
    const debouncedQuery = useDebouncedValue(query, 250);

    return (
        <Card>
            <CardHeader>
                <CardTitle id="bb-display" className="scroll-mt-24">
                    Display
                </CardTitle>
                <CardDescription>
                    CopyButton, DataList, LoadingOverlay, Indicator, Highlight, ShowMore and OverflowList.
                </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-8 md:grid-cols-2">
                <div className="space-y-3">
                    <p className="text-xs font-medium text-muted-foreground">DataList + CopyButton</p>
                    <DataList>
                        {[
                            ['Release', '1.4.2'],
                            ['Environment', 'production'],
                            ['Request id', 'req_01HZX4'],
                        ].map(([label, value]) => (
                            <DataListItem key={label}>
                                <DataListLabel>{label}</DataListLabel>
                                <DataListValue className="flex items-center gap-1 font-mono">
                                    {value}
                                    <CopyButton value={value} label={label.toLowerCase()} notify />
                                </DataListValue>
                            </DataListItem>
                        ))}
                    </DataList>
                    <DataList orientation="vertical" size="sm">
                        <DataListItem>
                            <DataListLabel>orientation=&quot;vertical&quot;</DataListLabel>
                            <DataListValue>Label above the value</DataListValue>
                        </DataListItem>
                    </DataList>
                </div>

                <div className="space-y-3">
                    <p className="text-xs font-medium text-muted-foreground">LoadingOverlay</p>
                    <div className="relative rounded-lg p-6 text-sm ring-1 ring-border" aria-busy={busy}>
                        <p>The content stays in place while it reloads.</p>
                        <LoadingOverlay visible={busy} label="Loading…" />
                    </div>
                    <Button size="sm" variant="outline" onClick={() => setBusy((b) => !b)}>
                        {busy ? 'Hide overlay' : 'Show overlay'}
                    </Button>
                </div>

                <div className="space-y-3">
                    <p className="text-xs font-medium text-muted-foreground">Indicator</p>
                    <div className="flex items-center gap-6">
                        <Indicator count={3} indicatorLabel="3 unread">
                            <Avatar>
                                <AvatarFallback>DT</AvatarFallback>
                            </Avatar>
                        </Indicator>
                        <Indicator count={240} tone="red" offset={2}>
                            <Avatar>
                                <AvatarFallback>AL</AvatarFallback>
                            </Avatar>
                        </Indicator>
                        <Indicator tone="green" processing position="bottom-end" offset={4}>
                            <Avatar>
                                <AvatarFallback>BO</AvatarFallback>
                            </Avatar>
                        </Indicator>
                        <Indicator label="New" tone="blue">
                            <Button variant="outline" size="icon" aria-label="Notifications">
                                <Bell />
                            </Button>
                        </Indicator>
                    </div>
                </div>

                <div className="space-y-3">
                    <p className="text-xs font-medium text-muted-foreground">Highlight (debounced search)</p>
                    <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Highlight…" />
                    <p className="text-sm">
                        <Highlight highlight={debouncedQuery.split(/\s+/).filter(Boolean)}>
                            Workers run at the edge, close to the people they work for, and D1 keeps the data at the
                            edge too.
                        </Highlight>
                    </p>
                </div>

                <div className="space-y-3">
                    <p className="text-xs font-medium text-muted-foreground">ShowMore</p>
                    <ShowMore maxHeight={60} className="text-sm">
                        <p>
                            {'A long paragraph that does not fit in sixty pixels, so the rest folds away. '.repeat(6)}
                        </p>
                    </ShowMore>
                </div>

                <div className="space-y-3">
                    <p className="text-xs font-medium text-muted-foreground">
                        OverflowList (resize the window: the &quot;+N&quot; count follows the width)
                    </p>
                    <OverflowList className="gap-1.5" items={TAGS} renderItem={(tag) => <Tag mono>{tag}</Tag>} />
                </div>
            </CardContent>
        </Card>
    );
}

function DiffCard() {
    return (
        <Card>
            <CardHeader>
                <CardTitle id="bb-diff" className="scroll-mt-24">
                    DiffView
                </CardTitle>
                <CardDescription>Field diff of two objects, and a line diff of two strings.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-6 md:grid-cols-2">
                <DiffView
                    before={{ name: 'Acme', plan: 'pro', seats: 5 }}
                    after={{ name: 'Acme Inc.', plan: 'pro', region: 'eu' }}
                />
                <DiffView before={'one\ntwo\nthree'} after={'one\n2\nthree\nfour'} />
            </CardContent>
        </Card>
    );
}

function HooksCard() {
    const [hits, setHits] = useState(0);
    const [dense, setDense] = useLocalStorage('ottabase.demo.dense', false);
    const { ref: sizeRef, width, height } = useElementSize();
    const isWide = useMediaQuery('(min-width: 1024px)');
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);
    useClickOutside(menuRef, () => setMenuOpen(false), menuOpen);
    useHotkeys([['mod+j', () => setHits((n) => n + 1)]]);

    return (
        <Card>
            <CardHeader>
                <CardTitle id="bb-hooks" className="scroll-mt-24">
                    Hooks
                </CardTitle>
                <CardDescription>
                    Also on <code>@ottabase/ui/hooks</code>. Debounce and clipboard are used in the cards above.
                </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-6 md:grid-cols-2">
                <div className="space-y-2 text-sm">
                    <p className="text-xs font-medium text-muted-foreground">useHotkeys</p>
                    <p>
                        Press{' '}
                        <Kbd>
                            <span className="text-xs">⌘/Ctrl</span>
                        </Kbd>{' '}
                        + <Kbd>J</Kbd>: pressed <strong>{hits}</strong> times.
                    </p>
                </div>

                <div className="space-y-2 text-sm">
                    <p className="text-xs font-medium text-muted-foreground">useLocalStorage (survives reload)</p>
                    <Button size="sm" variant="outline" onClick={() => setDense(!dense)}>
                        Dense: {dense ? 'on' : 'off'}
                    </Button>
                </div>

                <div className="space-y-2 text-sm">
                    <p className="text-xs font-medium text-muted-foreground">useElementSize (drag the corner)</p>
                    <div
                        ref={sizeRef}
                        className="flex h-20 w-56 min-w-32 resize items-center justify-center overflow-auto rounded-lg font-mono text-xs ring-1 ring-border"
                    >
                        {Math.round(width)} × {Math.round(height)}
                    </div>
                </div>

                <div className="space-y-2 text-sm">
                    <p className="text-xs font-medium text-muted-foreground">useMediaQuery + useClickOutside</p>
                    <p>
                        <code>(min-width: 1024px)</code>: {isWide ? 'matches' : 'does not match'}
                    </p>
                    <div ref={menuRef} className="relative inline-block">
                        <Button size="sm" variant="outline" onClick={() => setMenuOpen((o) => !o)}>
                            {menuOpen ? 'Click outside to close' : 'Open panel'}
                        </Button>
                        {menuOpen && (
                            <div className="absolute left-0 top-full z-10 mt-1 w-48 rounded-lg bg-popover p-3 text-xs shadow-md ring-1 ring-border">
                                Clicks in here keep it open.
                            </div>
                        )}
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}

export function BuildingBlocksSection() {
    return (
        <section className="space-y-4">
            <h2 className="text-2xl font-semibold">Building Blocks</h2>
            <div className="grid gap-4 lg:grid-cols-[1fr_12rem]">
                <div className="min-w-0 space-y-4">
                    <InputsCard />
                    <DisplayCard />
                    <DiffCard />
                    <HooksCard />
                </div>
                <aside className="hidden lg:block">
                    <TableOfContents
                        className="sticky top-24"
                        title="On this section"
                        items={TOC_ITEMS}
                        selector="#bb-inputs, #bb-display, #bb-diff, #bb-hooks"
                    />
                </aside>
            </div>
        </section>
    );
}
