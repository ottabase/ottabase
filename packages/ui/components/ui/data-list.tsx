import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@ottabase/ui/lib/utils';

/*
 * A semantic key/value list (<dl>). Horizontal puts the labels in their own
 * column (a subgrid row per item, so every value lines up); vertical stacks
 * each label over its value. Pass `sm:grid-cols-2` on a vertical list for
 * two columns of facts. Parts: data-list, data-list-item, data-list-label,
 * data-list-value. Orientation and size reach the parts through CSS
 * (group-data-*), so the list stays a server component.
 */

const dataListVariants = cva('group/data-list grid min-w-0', {
    variants: {
        orientation: {
            horizontal: 'grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5',
            vertical: 'gap-x-6 gap-y-3',
        },
        size: {
            sm: 'text-xs',
            default: 'text-sm',
        },
    },
    defaultVariants: { orientation: 'horizontal', size: 'default' },
});

export interface DataListProps extends React.HTMLAttributes<HTMLDListElement>, VariantProps<typeof dataListVariants> {}

const DataList = React.forwardRef<HTMLDListElement, DataListProps>(
    ({ orientation = 'horizontal', size = 'default', className, ...props }, ref) => (
        <dl
            ref={ref}
            data-slot="data-list"
            data-orientation={orientation}
            data-size={size}
            className={cn(dataListVariants({ orientation, size }), className)}
            {...props}
        />
    ),
);
DataList.displayName = 'DataList';

/** One label/value pair. A `<div>` is the one wrapper a `<dl>` allows around its dt/dd. */
const DataListItem = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    ({ className, ...props }, ref) => (
        <div
            ref={ref}
            data-slot="data-list-item"
            className={cn(
                'min-w-0',
                'group-data-[orientation=horizontal]/data-list:col-span-2 group-data-[orientation=horizontal]/data-list:grid group-data-[orientation=horizontal]/data-list:grid-cols-subgrid',
                'group-data-[orientation=vertical]/data-list:flex group-data-[orientation=vertical]/data-list:flex-col group-data-[orientation=vertical]/data-list:gap-0.5',
                className,
            )}
            {...props}
        />
    ),
);
DataListItem.displayName = 'DataListItem';

const DataListLabel = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
    ({ className, ...props }, ref) => (
        <dt
            ref={ref}
            data-slot="data-list-label"
            className={cn(
                'text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0',
                'group-data-[orientation=vertical]/data-list:text-xs',
                className,
            )}
            {...props}
        />
    ),
);
DataListLabel.displayName = 'DataListLabel';

const DataListValue = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
    ({ className, ...props }, ref) => (
        <dd
            ref={ref}
            data-slot="data-list-value"
            className={cn('m-0 min-w-0 break-words text-foreground', className)}
            {...props}
        />
    ),
);
DataListValue.displayName = 'DataListValue';

export { DataList, DataListItem, DataListLabel, DataListValue, dataListVariants };
