import type { Meta, StoryObj } from '@storybook/react-webpack5';
import { useState } from 'react';
import { Avatar, AvatarFallback } from '../components/ui/avatar';
import { DataList, DataListItem, DataListLabel, DataListValue } from '../components/ui/data-list';
import { DiffView } from '../components/ui/diff-view';
import { Highlight } from '../components/ui/highlight';
import { Indicator } from '../components/ui/indicator';
import { LoadingOverlay } from '../components/ui/loading-overlay';
import { OverflowList } from '../components/ui/overflow-list';
import { ShowMore } from '../components/ui/show-more';
import { Tag } from '../components/ui/status';

const meta: Meta = {
    title: 'Display building blocks',
    parameters: { layout: 'padded' },
};

export default meta;

type Story = StoryObj;

export const Facts: Story = {
    render: () => (
        <DataList className="max-w-sm">
            {[
                ['Release', '1.4.2'],
                ['Environment', 'production'],
                ['Request id', 'req_01HZX4'],
            ].map(([label, value]) => (
                <DataListItem key={label}>
                    <DataListLabel>{label}</DataListLabel>
                    <DataListValue className="font-mono">{value}</DataListValue>
                </DataListItem>
            ))}
        </DataList>
    ),
};

export const Overlay: Story = {
    render: function Render() {
        const [busy, setBusy] = useState(true);
        return (
            <div className="relative max-w-sm rounded-lg border p-6 text-sm" aria-busy={busy}>
                <p>Rows stay visible while they reload.</p>
                <button type="button" className="mt-2 underline" onClick={() => setBusy(!busy)}>
                    Toggle
                </button>
                <LoadingOverlay visible={busy} label="Loading…" />
            </div>
        );
    },
};

export const Indicators: Story = {
    render: () => (
        <div className="flex gap-6">
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
        </div>
    ),
};

export const TextTools: Story = {
    render: () => (
        <div className="flex max-w-md flex-col gap-4 text-sm">
            <Highlight highlight={['work', 'edge']}>
                Workers run at the edge, close to the people they work for.
            </Highlight>
            <ShowMore maxHeight={60}>
                <p>{'A long paragraph that does not fit in sixty pixels. '.repeat(8)}</p>
            </ShowMore>
            <OverflowList
                className="gap-1.5"
                items={['workers', 'd1', 'r2', 'queues', 'durable-objects', 'kv', 'vectorize']}
                renderItem={(tag) => <Tag mono>{tag}</Tag>}
            />
        </div>
    ),
};

export const Diffs: Story = {
    render: () => (
        <div className="flex max-w-md flex-col gap-4 text-sm">
            <DiffView
                before={{ name: 'Acme', plan: 'pro', seats: 5 }}
                after={{ name: 'Acme Inc.', plan: 'pro', region: 'eu' }}
            />
            <DiffView before={'one\ntwo\nthree'} after={'one\n2\nthree\nfour'} />
        </div>
    ),
};
