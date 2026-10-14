"use client";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { C } from "@/lib/format";

const tick = { fontSize: 11, fill: C.ink2 };
const tip = { contentStyle: { fontSize: 12, borderRadius: 6, border: "1px solid #e7e6e2", padding: "6px 8px" }, cursor: { fill: "#f4f3f0" } };

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
interface HBarProps { data: Row[]; x: string; y: string; format?: (v: number) => string; height?: number; name: string; highlight?: (d: any) => boolean; yWidth?: number }

/** Horizontal single-series bar chart (title names the series, so no legend). */
export function HBar({ data, x, y, format = (v) => v.toLocaleString(), height, name, highlight, yWidth = 150 }: HBarProps) {
  return (
    <ResponsiveContainer width="100%" height={height ?? Math.max(120, data.length * 26 + 24)}>
      <BarChart data={data} layout="vertical" margin={{ left: 0, right: 56, top: 4, bottom: 0 }} barCategoryGap={6}>
        <CartesianGrid horizontal={false} stroke={C.grid} />
        <XAxis type="number" tick={tick} tickFormatter={format} axisLine={false} tickLine={false} />
        <YAxis type="category" dataKey={y} tick={tick} width={yWidth} axisLine={false} tickLine={false} interval={0} />
        <Tooltip {...tip} formatter={(v) => [format(Number(v)), name]} />
        <Bar dataKey={x} name={name} radius={[0, 4, 4, 0]} maxBarSize={16} isAnimationActive={false}>
          {data.map((d, i) => <Cell key={i} fill={highlight ? (highlight(d) ? C.blue : C.gray) : C.blue} />)}
          <LabelList dataKey={x} position="right" formatter={(v) => format(Number(v))} style={{ fontSize: 11, fill: "#0b0b0b" }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Single-series line with markers (title names the series). */
export function Curve({ data, x, y, name, format = (v) => `${v}%`, xLabel, height = 200 }: { data: Row[]; x: string; y: string; name: string; format?: (v: number) => string; xLabel?: string; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ left: 0, right: 24, top: 8, bottom: xLabel ? 14 : 0 }}>
        <CartesianGrid vertical={false} stroke={C.grid} />
        <XAxis dataKey={x} tick={tick} axisLine={false} tickLine={false} label={xLabel ? { value: xLabel, position: "insideBottom", offset: -8, fontSize: 11, fill: C.ink2 } : undefined} />
        <YAxis tick={tick} tickFormatter={format} axisLine={false} tickLine={false} width={44} domain={[0, "auto"]} />
        <Tooltip {...tip} formatter={(v) => [format(Number(v)), name]} />
        <Line dataKey={y} name={name} stroke={C.blue} strokeWidth={2} dot={{ r: 4, fill: C.blue, stroke: "#fff", strokeWidth: 2 }} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Before / after grouped bars - one shared axis, legend always shown. */
export function BeforeAfter({ data, y, before, after, format = (v) => `${v}%`, height, domain }: { data: Row[]; y: string; before: string; after: string; format?: (v: number) => string; height?: number; domain?: [number, number] }) {
  return (
    <ResponsiveContainer width="100%" height={height ?? Math.max(160, data.length * 44 + 50)}>
      <BarChart data={data} layout="vertical" margin={{ left: 0, right: 48, top: 4, bottom: 0 }} barGap={2} barCategoryGap={10}>
        <CartesianGrid horizontal={false} stroke={C.grid} />
        <XAxis type="number" tick={tick} tickFormatter={format} axisLine={false} tickLine={false} domain={domain ?? [0, "auto"]} />
        <YAxis type="category" dataKey={y} tick={tick} width={210} axisLine={false} tickLine={false} interval={0} />
        <Tooltip {...tip} formatter={(v, n) => [format(Number(v)), n]} />
        <Legend verticalAlign="top" align="right" iconType="square" iconSize={9} wrapperStyle={{ fontSize: 11, color: C.ink2 }} />
        <Bar dataKey={before} name="Today (baseline)" fill={C.gray} radius={[0, 4, 4, 0]} maxBarSize={12} isAnimationActive={false} />
        <Bar dataKey={after} name="With hypothetical site(s)" fill={C.blue} radius={[0, 4, 4, 0]} maxBarSize={12} isAnimationActive={false}>
          <LabelList dataKey={after} position="right" formatter={(v) => format(Number(v))} style={{ fontSize: 11, fill: "#0b0b0b" }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
