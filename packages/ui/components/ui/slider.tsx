'use client';

import * as React from 'react';
import * as SliderPrimitive from '@radix-ui/react-slider';

import { cn } from '@ottabase/ui/lib/utils';

export interface SliderProps extends React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> {
    /** An accessible name per thumb (`['Minimum', 'Maximum']`). A single thumb falls back to `aria-label`. */
    thumbLabels?: string[];
}

/** One thumb per value, so `defaultValue={[20, 80]}` is a range slider. */
const Slider = React.forwardRef<React.ElementRef<typeof SliderPrimitive.Root>, SliderProps>(
    ({ className, thumbLabels, ...props }, ref) => {
        const count = Math.max(1, (props.value ?? props.defaultValue ?? []).length);
        return (
            <SliderPrimitive.Root
                ref={ref}
                data-slot="slider"
                className={cn('relative flex w-full touch-none select-none items-center', className)}
                {...props}
            >
                <SliderPrimitive.Track
                    data-slot="slider-track"
                    className="relative h-2 w-full grow overflow-hidden rounded-full bg-secondary"
                >
                    <SliderPrimitive.Range data-slot="slider-range" className="absolute h-full bg-primary" />
                </SliderPrimitive.Track>
                {Array.from({ length: count }, (_, index) => (
                    <SliderPrimitive.Thumb
                        key={index}
                        data-slot="slider-thumb"
                        aria-label={thumbLabels?.[index] ?? (count === 1 ? props['aria-label'] : undefined)}
                        className="block h-5 w-5 rounded-full border-2 border-primary bg-background transition disabled:pointer-events-none disabled:opacity-50"
                    />
                ))}
            </SliderPrimitive.Root>
        );
    },
);
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
