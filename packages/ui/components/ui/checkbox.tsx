'use client';

import * as React from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check, Minus } from 'lucide-react';

import { cn } from '@ottabase/ui/lib/utils';

/*
 * Theming hooks (BrandEngine): data-slot stamps for theme CSS; focus-visible
 * styling comes from the GLOBAL --focus-ring-* rule in styles/ui.css.
 * `checked="indeterminate"` shows a dash: both icons render, the Indicator's
 * data-state picks one (so it also flips correctly when uncontrolled).
 */
const Checkbox = React.forwardRef<
    React.ElementRef<typeof CheckboxPrimitive.Root>,
    React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
    <CheckboxPrimitive.Root
        ref={ref}
        data-slot="checkbox"
        className={cn(
            'peer size-4 shrink-0 rounded-[3px] border border-input bg-card shadow-xs transition duration-fast ease-theme hover:border-faint-foreground disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground',
            className,
        )}
        {...props}
    >
        <CheckboxPrimitive.Indicator
            data-slot="checkbox-indicator"
            className={cn('group/checkbox-indicator flex items-center justify-center text-current')}
        >
            <Check
                data-slot="checkbox-check"
                className="size-3.5 [stroke-width:2.5] group-data-[state=indeterminate]/checkbox-indicator:hidden"
            />
            <Minus
                data-slot="checkbox-dash"
                className="hidden size-3.5 [stroke-width:2.5] group-data-[state=indeterminate]/checkbox-indicator:block"
            />
        </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };
