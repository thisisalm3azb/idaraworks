"use client";

/**
 * Region step fields (U4): country select drives the timezone/currency
 * DEFAULTS (per-country suggestions) without overriding a value the founder
 * already changed by hand. Pure presentation — labels and option lists arrive
 * as serializable props from the server component.
 */
import { useState } from "react";

export type RegionOption = { value: string; label: string };

export type RegionDefaults = Record<string, { timezone: string; currency: string }>;

const selectCls = "min-h-11 rounded-md border border-line-strong bg-card px-3 text-base text-ink";
const fieldCls = "flex flex-col gap-1.5 text-sm font-medium text-ink";

export function RegionFields({
  countries,
  timezones,
  currencies,
  defaults,
  initial,
  labels,
}: {
  countries: RegionOption[];
  timezones: RegionOption[];
  currencies: RegionOption[];
  defaults: RegionDefaults;
  initial: { country: string; timezone: string; currency: string };
  labels: { country: string; timezone: string; currency: string; defaultsNote: string };
}) {
  const [country, setCountry] = useState(initial.country);
  const [timezone, setTimezone] = useState(initial.timezone);
  const [currency, setCurrency] = useState(initial.currency);
  const [tzTouched, setTzTouched] = useState(false);
  const [curTouched, setCurTouched] = useState(false);

  function onCountry(next: string) {
    setCountry(next);
    const d = defaults[next];
    if (d) {
      if (!tzTouched) setTimezone(d.timezone);
      if (!curTouched) setCurrency(d.currency);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <label className={fieldCls}>
        {labels.country}
        <select
          name="country"
          required
          value={country}
          onChange={(e) => onCountry(e.target.value)}
          className={selectCls}
        >
          {countries.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className={fieldCls}>
        {labels.timezone}
        <select
          name="timezone"
          required
          value={timezone}
          onChange={(e) => {
            setTimezone(e.target.value);
            setTzTouched(true);
          }}
          className={selectCls}
        >
          {timezones.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className={fieldCls}>
        {labels.currency}
        <select
          name="base_currency"
          required
          value={currency}
          onChange={(e) => {
            setCurrency(e.target.value);
            setCurTouched(true);
          }}
          className={selectCls}
        >
          {currencies.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs font-normal text-ink-muted">{labels.defaultsNote}</p>
    </div>
  );
}
