from __future__ import annotations

import csv
from pathlib import Path
from typing import Callable

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
REPORT_DIR = ROOT / "reports" / "primary-routing-benchmark"
SUMMARY_CSV = REPORT_DIR / "routing-benchmark-summary.csv"

COLORS = ["#4C78A8", "#F58518", "#54A24B", "#B279A2"]
INK = "#18212B"
MUTED = "#5D6975"
GRID = "#DCE2E8"
PANEL = "#F7F9FB"
WHITE = "#FFFFFF"


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    filename = "segoeuib.ttf" if bold else "segoeui.ttf"
    candidates = [
        Path("C:/Windows/Fonts") / filename,
        Path("C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default()


TITLE_FONT = font(38, bold=True)
SUBTITLE_FONT = font(20)
PANEL_TITLE_FONT = font(23, bold=True)
LABEL_FONT = font(17)
VALUE_FONT = font(17, bold=True)
FOOTNOTE_FONT = font(15)


def load_rows() -> list[dict[str, str]]:
    with SUMMARY_CSV.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def draw_pattern(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], index: int) -> None:
    left, top, right, bottom = box
    line_color = "#FFFFFF80"
    if index == 0:
        for x in range(left - (bottom - top), right, 14):
            draw.line((x, bottom, x + (bottom - top), top), fill=line_color, width=2)
    elif index == 1:
        for x in range(left + 7, right, 14):
            draw.line((x, top + 2, x, bottom - 2), fill=line_color, width=2)
    elif index == 2:
        for y in range(top + 7, bottom, 13):
            for x in range(left + 7, right, 13):
                draw.ellipse((x - 1, y - 1, x + 1, y + 1), fill=line_color)
    else:
        for x in range(left - (bottom - top), right, 15):
            draw.line((x, bottom, x + (bottom - top), top), fill=line_color, width=2)
            draw.line((x, top, x + (bottom - top), bottom), fill=line_color, width=2)


def text_width(draw: ImageDraw.ImageDraw, value: str, value_font: ImageFont.ImageFont) -> int:
    bounds = draw.textbbox((0, 0), value, font=value_font)
    return bounds[2] - bounds[0]


def draw_horizontal_panel(
    draw: ImageDraw.ImageDraw,
    rows: list[dict[str, str]],
    bounds: tuple[int, int, int, int],
    title: str,
    field: str,
    axis_max: float,
    formatter: Callable[[float], str],
    ticks: list[float],
) -> None:
    left, top, right, bottom = bounds
    draw.rounded_rectangle(bounds, radius=16, fill=PANEL, outline=GRID, width=2)
    draw.text((left + 24, top + 18), title, fill=INK, font=PANEL_TITLE_FONT)
    plot_left = left + 245
    plot_right = right - 46
    plot_top = top + 78
    plot_bottom = bottom - 54
    for tick in ticks:
        x = round(plot_left + (plot_right - plot_left) * tick / axis_max)
        draw.line((x, plot_top, x, plot_bottom), fill=GRID, width=1)
        tick_label = formatter(tick)
        draw.text(
            (x - text_width(draw, tick_label, FOOTNOTE_FONT) / 2, plot_bottom + 12),
            tick_label,
            fill=MUTED,
            font=FOOTNOTE_FONT,
        )
    row_height = (plot_bottom - plot_top) / len(rows)
    bar_height = min(42, int(row_height * 0.58))
    for index, row in enumerate(rows):
        center_y = round(plot_top + row_height * (index + 0.5))
        value = float(row[field])
        bar_right = round(plot_left + (plot_right - plot_left) * max(0.0, value) / axis_max)
        label = row["label"]
        draw.text((left + 24, center_y - 12), label, fill=INK, font=LABEL_FONT)
        bar_box = (plot_left, center_y - bar_height // 2, max(plot_left + 1, bar_right), center_y + bar_height // 2)
        draw.rectangle(bar_box, fill=COLORS[index], outline=INK, width=1)
        draw_pattern(draw, bar_box, index)
        value_label = formatter(value)
        label_width = text_width(draw, value_label, VALUE_FONT)
        if bar_right + label_width + 12 <= plot_right:
            value_x = bar_right + 8
            value_color = INK
        else:
            value_x = max(plot_left + 5, bar_right - label_width - 8)
            value_color = WHITE
        draw.text((value_x, center_y - 12), value_label, fill=value_color, font=VALUE_FONT)
    draw.line((plot_left, plot_top, plot_left, plot_bottom), fill=INK, width=2)


def render_quality(rows: list[dict[str, str]]) -> None:
    width, height = 1800, 1180
    image = Image.new("RGB", (width, height), WHITE)
    draw = ImageDraw.Draw(image, "RGBA")
    best = max(rows, key=lambda row: float(row["macro_f1_pct"]))
    draw.text((70, 48), f'{best["label"]} leads Macro F1 on the 40-query set', fill=INK, font=TITLE_FONT)
    draw.text(
        (70, 103),
        "Offline deterministic routing; all percentage bars start at zero and carry direct labels",
        fill=MUTED,
        font=SUBTITLE_FONT,
    )
    panel_width = 820
    panel_height = 430
    x_positions = [70, 910]
    y_positions = [165, 620]
    panels = [
        ("Macro F1", "macro_f1_pct"),
        ("Exact match", "exact_match_pct"),
        ("Critical-role recall", "critical_role_recall_pct"),
        ("Primary in expected set", "primary_in_expected_pct"),
    ]
    for index, (title, field) in enumerate(panels):
        column = index % 2
        row_index = index // 2
        bounds = (
            x_positions[column],
            y_positions[row_index],
            x_positions[column] + panel_width,
            y_positions[row_index] + panel_height,
        )
        draw_horizontal_panel(
            draw,
            rows,
            bounds,
            title,
            field,
            100.0,
            lambda value: f"{value:.1f}%",
            [0, 25, 50, 75, 100],
        )
    draw.text(
        (70, 1100),
        "Source: data/evaluation/ax-golden-set-40.jsonl. Primary is scored by expected-set membership; not held out.",
        fill=MUTED,
        font=FOOTNOTE_FONT,
    )
    image.save(REPORT_DIR / "routing-quality.png", format="PNG", optimize=True)


def render_efficiency(rows: list[dict[str, str]]) -> None:
    width, height = 1800, 720
    image = Image.new("RGB", (width, height), WHITE)
    draw = ImageDraw.Draw(image, "RGBA")
    lowest_fanout = min(rows, key=lambda row: float(row["average_fan_out"]))
    draw.text((70, 48), f'{lowest_fanout["label"]} minimizes Agent fan-out', fill=INK, font=TITLE_FONT)
    draw.text(
        (70, 103),
        "Routing-only efficiency; RAG, LLM, network, and process startup are excluded",
        fill=MUTED,
        font=SUBTITLE_FONT,
    )
    fanout_max = max(float(row["average_fan_out"]) for row in rows)
    fanout_axis = max(1.0, fanout_max * 1.25)
    decision_values_us = [float(row["routing_policy_time_median_ms"]) * 1_000 for row in rows]
    decision_axis = max(1.0, max(decision_values_us) * 1.25)
    draw_horizontal_panel(
        draw,
        rows,
        (70, 165, 890, 595),
        "Average fan-out (Agents/query)",
        "average_fan_out",
        fanout_axis,
        lambda value: f"{value:.2f}",
        [0, fanout_axis / 4, fanout_axis / 2, fanout_axis * 3 / 4, fanout_axis],
    )
    timing_rows = [dict(row, decision_time_us=float(row["routing_policy_time_median_ms"]) * 1_000) for row in rows]
    draw_horizontal_panel(
        draw,
        timing_rows,
        (910, 165, 1730, 595),
        "Routing-policy CPU median (us/query)",
        "decision_time_us",
        decision_axis,
        lambda value: f"{value:.2f}",
        [0, decision_axis / 4, decision_axis / 2, decision_axis * 3 / 4, decision_axis],
    )
    draw.text(
        (70, 640),
        "Proposed timing uses precomputed primary coverage; all values exclude Edge/RAG/LLM and are not end-to-end latency.",
        fill=MUTED,
        font=FOOTNOTE_FONT,
    )
    image.save(REPORT_DIR / "routing-efficiency.png", format="PNG", optimize=True)


def main() -> None:
    rows = load_rows()
    if len(rows) < 3:
        raise RuntimeError(f"Expected at least three methods, found {len(rows)}")
    render_quality(rows)
    render_efficiency(rows)
    for filename in ["routing-quality.png", "routing-efficiency.png"]:
        path = REPORT_DIR / filename
        print(f"wrote {path} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
