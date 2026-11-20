import { act, fireEvent, render } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { FuzzyDateTime } from '../core/types';
import * as root from '../index';
import * as react from '../react';
import { DatePicker, DateRangePicker, FuzzyDateTimePicker } from '../react';

const JAN_1_2025 = 1735689600;
const JAN_15_2025 = 1736899200;
const JUN_1_2025 = 1748736000;

const trigger = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('.ottadate-trigger')!;
const triggerText = (c: HTMLElement) => c.querySelector('.ottadate-trigger-text')!.textContent;

function clickDay(c: HTMLElement, day: string) {
    const cell = Array.from(c.querySelectorAll<HTMLButtonElement>('.ottadate-day:not(.ottadate-day--outside)')).find(
        (b) => b.textContent === day,
    )!;
    act(() => cell.click());
}

describe('entrypoint boundary', () => {
    it('keeps React components out of the headless root and exposes them on /react', () => {
        for (const name of [
            'DatePicker',
            'DateRangePicker',
            'DateTimePicker',
            'FuzzyDateTimePicker',
            'FuzzyDateTimeCompact',
        ]) {
            expect(root).not.toHaveProperty(name);
            expect(react).toHaveProperty(name, expect.any(Function));
        }
        expect(root.createDatePicker).toEqual(expect.any(Function));
    });
});

describe('DatePicker (react)', () => {
    it('mounts the vanilla picker and destroys it on unmount', () => {
        const { container, unmount } = render(<DatePicker timezone="UTC" placeholder="Pick one" />);
        expect(container.querySelectorAll('.ottadate')).toHaveLength(1);
        expect(triggerText(container)).toBe('Pick one');
        // Open it so the picker holds document listeners that destroy() must release
        fireEvent.click(trigger(container));
        const wrapper = container.firstElementChild!;
        const removed = vi.spyOn(document, 'removeEventListener');
        unmount();
        // React detaches the wrapper but leaves its children; only destroy() empties it
        expect(wrapper.childNodes).toHaveLength(0);
        const types = removed.mock.calls.map(([type]) => type);
        expect(types).toContain('mousedown');
        expect(types).toContain('keydown');
        removed.mockRestore();
    });

    it('mounts exactly one picker under StrictMode', () => {
        const spy = vi.fn();
        const { container } = render(
            <StrictMode>
                <DatePicker timezone="UTC" inline value={JAN_1_2025} onChange={spy} />
            </StrictMode>,
        );
        expect(container.querySelectorAll('.ottadate')).toHaveLength(1);
        clickDay(container, '15');
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith(JAN_15_2025);
    });

    it('pushes a new controlled value into the same picker instance without echoing onChange', () => {
        const onChange = vi.fn();
        const { container, rerender } = render(<DatePicker timezone="UTC" value={JAN_1_2025} onChange={onChange} />);
        const first = trigger(container);
        expect(triggerText(container)).toBe('Jan 1, 2025');
        rerender(<DatePicker timezone="UTC" value={JUN_1_2025} onChange={onChange} />);
        expect(triggerText(container)).toBe('Jun 1, 2025');
        expect(trigger(container)).toBe(first);
        rerender(<DatePicker timezone="UTC" value={null} placeholder="Empty" onChange={onChange} />);
        expect(triggerText(container)).toBe('Empty');
        expect(trigger(container)).toBe(first);
        expect(onChange).not.toHaveBeenCalled();
    });

    it('updates a non-creation option in place', () => {
        const { container, rerender } = render(<DatePicker timezone="UTC" value={null} placeholder="First" />);
        const first = trigger(container);
        rerender(<DatePicker timezone="UTC" value={null} placeholder="Second" />);
        expect(trigger(container)).toBe(first);
        expect(triggerText(container)).toBe('Second');
    });

    it('calls onChange with the picked value and reflects parent state', () => {
        const spy = vi.fn();
        function Form() {
            const [value, setValue] = useState<number | string | Date | null>(JAN_1_2025);
            return (
                <DatePicker
                    timezone="UTC"
                    inline
                    value={value}
                    onChange={(v) => {
                        spy(v);
                        setValue(v);
                    }}
                />
            );
        }
        const { container } = render(<Form />);
        clickDay(container, '15');
        expect(spy).toHaveBeenCalledWith(JAN_15_2025);
        expect(container.querySelector('.ottadate-day--selected')!.textContent).toBe('15');
    });

    it('snaps back to `value` when the parent ignores onChange', () => {
        const { container } = render(<DatePicker timezone="UTC" inline value={JAN_1_2025} onChange={() => {}} />);
        clickDay(container, '15');
        expect(container.querySelector('.ottadate-day--selected')!.textContent).toBe('1');
    });

    it('does not recreate the picker when only onChange identity changes', () => {
        const first = vi.fn();
        const second = vi.fn();
        const { container, rerender } = render(
            <DatePicker timezone="UTC" inline value={JAN_1_2025} onChange={first} />,
        );
        const pickerRoot = container.querySelector('.ottadate');
        rerender(<DatePicker timezone="UTC" inline value={JAN_1_2025} onChange={second} />);
        expect(container.querySelector('.ottadate')).toBe(pickerRoot);
        clickDay(container, '15');
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledWith(JAN_15_2025);
    });

    it('recreates the picker when a creation-time option changes', () => {
        const { container, rerender } = render(<DatePicker timezone="UTC" value={JAN_1_2025} />);
        const pickerRoot = container.querySelector('.ottadate');
        rerender(<DatePicker timezone="Asia/Tokyo" value={JAN_1_2025} />);
        expect(container.querySelector('.ottadate')).not.toBe(pickerRoot);
        expect(container.querySelectorAll('.ottadate')).toHaveLength(1);
        // The rebuilt picker starts from the current value (midnight UTC = 09:00 in Tokyo, same day)
        expect(triggerText(container)).toBe('Jan 1, 2025');
    });

    it('serialises the hidden input: unix as-is, ranges as JSON, empty when cleared', () => {
        const { container, rerender } = render(<DatePicker timezone="UTC" name="d" value={null} />);
        const input = () => container.querySelector('input[type="hidden"][name="d"]');
        expect(input()).toHaveValue('');
        rerender(<DateRangePicker timezone="UTC" name="d" value={{ start: JAN_1_2025, end: JAN_15_2025 }} />);
        expect(JSON.parse((input() as HTMLInputElement).value)).toEqual({ start: JAN_1_2025, end: JAN_15_2025 });
    });

    it('fills the hidden input from picks when uncontrolled', () => {
        const { container } = render(<DatePicker timezone="UTC" inline name="d" />);
        clickDay(container, '15');
        expect(container.querySelector('input[type="hidden"][name="d"]')).not.toHaveValue('');
    });

    it('forwards id/aria/disabled to the trigger and name to a hidden input', () => {
        const { container, rerender } = render(
            <DatePicker timezone="UTC" id="due" aria-label="Due date" name="due" value={JAN_1_2025} disabled />,
        );
        expect(trigger(container)).toHaveAttribute('id', 'due');
        expect(trigger(container)).toHaveAttribute('aria-label', 'Due date');
        expect(trigger(container)).toHaveAttribute('aria-disabled', 'true');
        expect(container.querySelector('input[type="hidden"][name="due"]')).toHaveValue(String(JAN_1_2025));
        fireEvent.click(trigger(container));
        expect(container.querySelector<HTMLElement>('.ottadate-popover')!.style.display).toBe('none');
        rerender(<DatePicker timezone="UTC" id="due" name="due" value={JAN_1_2025} />);
        expect(trigger(container)).not.toHaveAttribute('aria-disabled');
        expect(trigger(container)).not.toHaveAttribute('aria-label');
    });
});

describe('other pickers (react)', () => {
    it('DateRangePicker shows a controlled range', () => {
        const { container } = render(
            <DateRangePicker timezone="UTC" value={{ start: JAN_1_2025, end: JAN_15_2025 }} />,
        );
        expect(triggerText(container)).toContain('Jan 1, 2025');
        expect(triggerText(container)).toContain('Jan 15, 2025');
    });

    it('DateRangePicker keeps a half-picked range across unrelated parent renders', () => {
        const onChange = vi.fn();
        const value = { start: JAN_1_2025, end: JAN_15_2025 };
        const { container, rerender } = render(
            <DateRangePicker timezone="UTC" inline value={value} onChange={onChange} />,
        );
        clickDay(container, '10'); // start only: no onChange yet
        rerender(<DateRangePicker timezone="UTC" inline value={value} onChange={onChange} />);
        clickDay(container, '20');
        expect(onChange).toHaveBeenCalledWith({ start: 1736467200, end: 1737331200 }); // Jan 10 – Jan 20
    });

    it('FuzzyDateTimePicker shows a controlled fuzzy value', () => {
        const fuzzy: FuzzyDateTime = root.createFuzzyDateTime(new Date(JAN_1_2025 * 1000), 'year');
        const { container } = render(<FuzzyDateTimePicker timezone="UTC" value={fuzzy} />);
        expect(triggerText(container)).toBe(fuzzy.label);
    });
});
