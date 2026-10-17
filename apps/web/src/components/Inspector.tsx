import { AudioLines, AudioWaveform, Clapperboard, Diamond, Film, RotateCcw, Sun, Trash2, Type } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useSyncExternalStore, type ReactNode } from "react";

import { CLIP_HEX } from "../lib/colors";
import {
  deleteClips,
  isAnimated,
  keyframeAt,
  longest,
  mediaOf,
  setDuration,
  setSpeed,
  paramAt,
  projectDuration,
  setParam,
  toggleAnimated,
  toggleKeyframe,
} from "../lib/edit";
import { recolourPerson } from "../lib/people";
import { FONTS, playhead } from "../lib/playback";
import { openDialog } from "../lib/dialogs";
import { useEditor } from "../lib/store";
import { shortDuration, timecode } from "../lib/time";
import { HOUSE_BOX, HOUSE_SHADOW, resolvedShake, SHAKE_PRESETS, type Clip, type Project, type Rgba, type ShakeDirection, type ShakeEdges, type ShakeEnvelope, type ShakeMotion, type ShakePreset, type TextPreset } from "../lib/types";
import { Button, ColorField, cx, Kbd, Scrub, Select, Switch } from "./ui";

const useInspectorFrame = () =>
  useSyncExternalStore(playhead.subscribe, () => (playhead.playing ? Math.floor(playhead.frame / 6) * 6 : Math.floor(playhead.frame)));

export function Inspector() {
  const project = useEditor((state) => state.project)!;
  const selection = useEditor((state) => state.selection);
  const clips = project.clips.filter((clip) => selection.includes(clip.id));
  const key = clips.length === 1 ? clips[0].id : clips.length ? "many" : "none";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={key}
          initial={{ opacity: 0, x: 6 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -4 }}
          transition={{ duration: 0.12 }}
          className="flex min-h-0 flex-1 flex-col"
        >
          {clips.length === 1 ? (
            <ClipInspector clip={clips[0]} project={project} />
          ) : clips.length > 1 ? (
            <Many clips={clips} />
          ) : (
            <ProjectInfo project={project} />
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function Header({ icon, title, subtitle, color }: { icon: ReactNode; title: string; subtitle?: string; color?: string }) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-line px-3">
      <span className="flex size-6 items-center justify-center rounded-md" style={{ background: color ? `${color}33` : undefined, color }}>
        {icon}
      </span>
      <div className="min-w-0">
        <div className="truncate font-medium">{title}</div>
      </div>
      {subtitle && <span className="ml-auto shrink-0 text-[11px] text-faint tabular">{subtitle}</span>}
    </div>
  );
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="border-b border-line px-3 py-2.5 last:border-b-0">
      <div className="mb-1.5 flex h-5 items-center justify-between">
        <span className="text-[11px] font-medium tracking-wide text-faint uppercase">{title}</span>
        {aside}
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

function Row({ label, children, keyframe }: { label: string; children: ReactNode; keyframe?: ReactNode }) {
  return (
    <div className="grid h-7 grid-cols-[1fr_16px_112px] items-center gap-1.5">
      <span className="truncate text-muted">{label}</span>
      <span className="flex justify-center">{keyframe}</span>
      <div className="flex justify-end">{children}</div>
    </div>
  );
}

const WEIGHT_NAMES: Record<number, string> = {
  400: "Regular",
  500: "Medium",
  600: "Semibold",
  700: "Bold",
  900: "Black",
};
const FAMILIES = [...new Set(FONTS.map(([family]) => family))];
const weightsOf = (family: string) => FONTS.filter(([name]) => name === family).map(([, weight]) => weight);

const clipIcon = (clip: Clip) =>
  ({
    video: <Film size={14} />,
    audio: <AudioLines size={14} />,
    text: <Type size={14} />,
    adjustment: <Sun size={14} />,
    solid: <Clapperboard size={14} />,
    waveform: <AudioWaveform size={14} />,
  })[clip.type];

export function clipTitle(project: Project, clip: Clip) {
  if (clip.name) return clip.name;
  if (clip.type === "video" || clip.type === "audio") return mediaOf(project, clip.media)?.name ?? "Missing media";
  if (clip.type === "text") return clip.text.split("\n")[0] || "Text";
  if (clip.type === "adjustment") return "Adjustment layer";
  if (clip.type === "waveform") return "Waveform";
  return clip.fill[0] + clip.fill[1] + clip.fill[2] > 1.5 ? "Flash" : "Solid";
}

function useClipEditor(clip: Clip) {
  const state = useEditor.getState;
  const update = (recipe: (clip: Clip) => void) =>
    state().gesture((draft) => {
      const live = draft.clips.find((candidate) => candidate.id === clip.id);
      if (live) recipe(live as Clip);
    });
  const once = (recipe: (clip: Clip) => void) =>
    state().edit((draft) => {
      const live = draft.clips.find((candidate) => candidate.id === clip.id);
      if (live) recipe(live as Clip);
    });
  // A person's subtitle: its colour is theirs, so all of their clips change with it.
  const recolour = (color: Rgba, own: (clip: Clip) => void) =>
    state().edit((draft) => {
      const live = draft.clips.find((candidate) => candidate.id === clip.id);
      if (live && !recolourPerson(draft, live as Clip, color)) own(live as Clip);
    });
  return {
    begin: () => state().beginGesture(),
    end: () => state().endGesture(),
    update,
    once,
    recolour,
  };
}

function ClipInspector({ clip, project }: { clip: Clip; project: Project }) {
  const frame = useInspectorFrame();
  const fps = project.settings.fps;
  const { begin, end, update, once, recolour } = useClipEditor(clip);
  const inside = frame >= clip.start && frame < clip.start + clip.duration;

  const param = (
    label: string,
    name: string,
    options: {
      step?: number;
      min?: number;
      max?: number;
      precision?: number;
      suffix?: string;
      scale?: number;
    } = {},
  ) => {
    const scale = options.scale ?? 1;
    const animated = isAnimated(clip, name);
    const onKey = keyframeAt(clip, name, frame);
    return (
      <Row
        key={name}
        label={label}
        keyframe={
          <button
            title={animated ? "Add/remove keyframe here · ⌥-click to stop animating" : "Animate this value"}
            disabled={!inside}
            onClick={(event) => once((live) => (animated && !event.altKey ? toggleKeyframe(live, name, frame) : toggleAnimated(live, name, frame)))}
            className={cx("transition-colors disabled:opacity-20", animated ? "text-amber-300" : "text-faint hover:text-muted")}
          >
            <Diamond size={11} fill={onKey ? "currentColor" : "none"} strokeWidth={2.2} />
          </button>
        }
      >
        <Scrub
          value={paramAt(clip, name, frame) * scale}
          step={options.step ?? 1}
          min={options.min}
          max={options.max}
          precision={options.precision ?? 0}
          suffix={options.suffix}
          onStart={begin}
          onEnd={end}
          onChange={(value) => update((live) => setParam(live, name, value / scale, frame))}
        />
      </Row>
    );
  };

  /** A plain number (not animatable), scrubbed as one undo step. */
  const field = (
    label: string,
    value: number,
    set: (clip: Clip, value: number) => void,
    options: {
      step?: number;
      min?: number;
      max?: number;
      precision?: number;
      suffix?: string;
      scale?: number;
    } = {},
  ) => {
    const scale = options.scale ?? 1;
    return (
      <Row key={label} label={label}>
        <Scrub
          value={value * scale}
          step={options.step ?? 1}
          min={options.min}
          max={options.max}
          precision={options.precision ?? 0}
          suffix={options.suffix}
          onStart={begin}
          onEnd={end}
          onChange={(next) => update((live) => set(live, next / scale))}
        />
      </Row>
    );
  };

  const transform = "transform" in clip && (
    <Section title="Transform">
      {param("Position X", "x")}
      {param("Position Y", "y")}
      {param("Scale", "scale", {
        step: 0.5,
        min: 0,
        precision: 1,
        suffix: "%",
        scale: 100,
      })}
      {param("Rotation", "rotation", { step: 0.5, precision: 1, suffix: "°" })}
      {param("Shake", "shake", { step: 0.25, min: 0, max: 80, precision: 1, suffix: "px" })}
      {param("Opacity", "opacity", {
        step: 0.5,
        min: 0,
        max: 100,
        suffix: "%",
        scale: 100,
      })}
    </Section>
  );

  return (
    <>
      <Header icon={clipIcon(clip)} title={clipTitle(project, clip)} color={CLIP_HEX[clip.color]} subtitle={shortDuration(clip.duration / fps)} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {clip.type === "text" && (
          <>
            <Section title="Text">
              <textarea
                value={clip.text}
                rows={Math.min(5, clip.text.split("\n").length + 1)}
                onChange={(event) => once((live) => live.type === "text" && (live.text = event.target.value))}
                onKeyDown={(event) => event.stopPropagation()}
                className="mb-1.5 w-full resize-none rounded-lg border border-line bg-black px-2.5 py-2 text-[13px] text-fg outline-none focus:border-line-strong"
              />
              <Row label="Font">
                <Select
                  value={clip.style.font}
                  onChange={(font) =>
                    once((live) => {
                      if (live.type !== "text") return;
                      live.style.font = font;
                      const weights = weightsOf(font);
                      if (!weights.includes(live.style.weight))
                        live.style.weight = weights.reduce((best, weight) =>
                          Math.abs(weight - live.style.weight) < Math.abs(best - live.style.weight) ? weight : best,
                        );
                    })
                  }
                  options={(FAMILIES.includes(clip.style.font) ? FAMILIES : [clip.style.font, ...FAMILIES]).map((family) => ({ value: family, label: family }))}
                />
              </Row>
              {weightsOf(clip.style.font).length > 1 && (
                <Row label="Weight">
                  <Select
                    value={clip.style.weight}
                    onChange={(weight) => once((live) => live.type === "text" && (live.style.weight = weight))}
                    options={weightsOf(clip.style.font).map((weight) => ({
                      value: weight,
                      label: WEIGHT_NAMES[weight] ?? String(weight),
                    }))}
                  />
                </Row>
              )}
              {param("Size", "size", { min: 4, suffix: "px" })}
              <Row label="Color">
                <ColorField
                  value={clip.style.color}
                  onChange={(color) =>
                    clip.style.label
                      ? once((live) => live.type === "text" && (live.style.color = color))
                      : recolour(color, (live) => live.type === "text" && (live.style.color = color))
                  }
                />
              </Row>
              {param("Tracking", "tracking", { step: 0.25, precision: 1 })}
              <Row label="Wrap">
                <Switch
                  checked={clip.style.max_width != null}
                  onChange={(wrap) =>
                    once((live) => {
                      if (live.type !== "text") return;
                      if (wrap) live.style.max_width = Math.round(project.settings.width * 0.8);
                      else delete live.style.max_width;
                    })
                  }
                />
              </Row>
              {clip.style.max_width != null &&
                field("Wrap width", clip.style.max_width, (live, value) => live.type === "text" && (live.style.max_width = value), { min: 1, suffix: "px" })}
            </Section>
            <Section
              title="Box"
              aside={
                <Switch
                  checked={Boolean(clip.style.background)}
                  onChange={(on) =>
                    once((live) => {
                      if (live.type !== "text") return;
                      if (on) live.style.background = { ...HOUSE_BOX };
                      else delete live.style.background;
                    })
                  }
                />
              }
            >
              {clip.style.background && (
                <>
                  <Row label="Color">
                    <ColorField
                      value={clip.style.background.color}
                      onChange={(color) => once((live) => live.type === "text" && live.style.background && (live.style.background.color = color))}
                    />
                  </Row>
                  {field(
                    "Opacity",
                    clip.style.background.opacity,
                    (live, value) => live.type === "text" && live.style.background && (live.style.background.opacity = value),
                    {
                      step: 0.5,
                      min: 0,
                      max: 100,
                      suffix: "%",
                      scale: 100,
                    },
                  )}
                  {field(
                    "Padding X",
                    clip.style.background.pad_x,
                    (live, value) => live.type === "text" && live.style.background && (live.style.background.pad_x = value),
                    { min: 0, suffix: "px" },
                  )}
                  {field(
                    "Padding Y",
                    clip.style.background.pad_y,
                    (live, value) => live.type === "text" && live.style.background && (live.style.background.pad_y = value),
                    { min: 0, suffix: "px" },
                  )}
                  {field(
                    "Border",
                    clip.style.background.border ?? 0,
                    (live, value) => live.type === "text" && live.style.background && (live.style.background.border = value),
                    { min: 0, suffix: "px" },
                  )}
                  {(clip.style.background.border ?? 0) > 0 && (
                    <Row label="Border color">
                      <ColorField
                        value={clip.style.background.border_color ?? [1, 1, 1, 1]}
                        onChange={(color) => once((live) => live.type === "text" && live.style.background && (live.style.background.border_color = color))}
                      />
                    </Row>
                  )}
                </>
              )}
            </Section>
            <Section
              title="Shadow"
              aside={
                <Switch
                  checked={Boolean(clip.style.shadow)}
                  onChange={(on) =>
                    once((live) => {
                      if (live.type !== "text") return;
                      if (on) live.style.shadow = { ...HOUSE_SHADOW };
                      else delete live.style.shadow;
                    })
                  }
                />
              }
            >
              {clip.style.shadow && (
                <>
                  <Row label="Color">
                    <ColorField
                      value={clip.style.shadow.color}
                      onChange={(color) => once((live) => live.type === "text" && live.style.shadow && (live.style.shadow.color = color))}
                    />
                  </Row>
                  {field(
                    "Opacity",
                    clip.style.shadow.opacity,
                    (live, value) => live.type === "text" && live.style.shadow && (live.style.shadow.opacity = value),
                    {
                      step: 0.5,
                      min: 0,
                      max: 100,
                      suffix: "%",
                      scale: 100,
                    },
                  )}
                  {field(
                    "Distance",
                    clip.style.shadow.distance,
                    (live, value) => live.type === "text" && live.style.shadow && (live.style.shadow.distance = value),
                    { step: 0.5, min: 0, precision: 1, suffix: "px" },
                  )}
                  {field("Angle", clip.style.shadow.angle, (live, value) => live.type === "text" && live.style.shadow && (live.style.shadow.angle = value), {
                    suffix: "°",
                  })}
                  {field("Size", clip.style.shadow.size, (live, value) => live.type === "text" && live.style.shadow && (live.style.shadow.size = value), {
                    step: 0.5,
                    min: 0,
                    precision: 1,
                    suffix: "px",
                  })}
                  {field("Blur", clip.style.shadow.blur, (live, value) => live.type === "text" && live.style.shadow && (live.style.shadow.blur = value), {
                    step: 0.5,
                    min: 0,
                    precision: 1,
                    suffix: "px",
                  })}
                </>
              )}
            </Section>
            <Section
              title="Glow"
              aside={
                <Switch checked={clip.style.glow.enabled} onChange={(enabled) => once((live) => live.type === "text" && (live.style.glow.enabled = enabled))} />
              }
            >
              {clip.style.glow.enabled && (
                <>
                  <Row
                    label="Color"
                    keyframe={
                      clip.style.glow.color ? (
                        <button
                          title="Match the text colour"
                          onClick={() => once((live) => live.type === "text" && (live.style.glow.color = null))}
                          className="text-faint transition-colors hover:text-fg"
                        >
                          <RotateCcw size={11} />
                        </button>
                      ) : undefined
                    }
                  >
                    <ColorField
                      value={clip.style.glow.color ?? clip.style.color}
                      label={clip.style.glow.color ? undefined : "Text"}
                      onChange={(color) => once((live) => live.type === "text" && (live.style.glow.color = color))}
                    />
                  </Row>
                  {param("Blur", "glow.radius", {
                    min: 0,
                    max: 200,
                    suffix: "px",
                  })}
                  {param("Opacity", "glow.strength", {
                    step: 0.5,
                    min: 0,
                    max: 100,
                    suffix: "%",
                    scale: 100,
                  })}
                </>
              )}
            </Section>
            <Section
              title="Speaker label"
              aside={
                <Switch
                  checked={Boolean(clip.style.label)}
                  onChange={(on) =>
                    once((live) => {
                      if (live.type !== "text") return;
                      // A label on or off changes which colour shows (the label's or the
                      // text's): the clip stops being a person's until the next subtitle run.
                      delete live.person;
                      if (!on) delete live.style.label;
                      else live.style.label = { text: "Speaker:", color: [1, 0.86, 0.2, 1], size: Math.round((live.style.size * 26) / 48) };
                    })
                  }
                />
              }
            >
              {clip.style.label && (
                <>
                  <Row label="Name">
                    <input
                      value={clip.style.label.text}
                      onChange={(event) => once((live) => live.type === "text" && live.style.label && (live.style.label.text = event.target.value))}
                      spellCheck={false}
                      className="h-6 w-full min-w-0 rounded-md bg-raised px-1.5 text-right text-[12px] text-fg outline-none ring-1 ring-line focus:ring-line-strong"
                    />
                  </Row>
                  <Row label="Color">
                    <ColorField
                      value={clip.style.label.color}
                      onChange={(color) => recolour(color, (live) => live.type === "text" && live.style.label && (live.style.label.color = color))}
                    />
                  </Row>
                  {field("Size", clip.style.label.size, (live, value) => live.type === "text" && live.style.label && (live.style.label.size = value), {
                    min: 1,
                    suffix: "px",
                  })}
                </>
              )}
            </Section>
            <Section title="Animate in">
              <Row label="Style">
                <Select<TextPreset>
                  value={clip.animation.preset}
                  onChange={(preset) => once((live) => live.type === "text" && (live.animation.preset = preset))}
                  options={[
                    { value: "none", label: "None" },
                    { value: "fade", label: "Fade" },
                    { value: "rise", label: "Rise" },
                    { value: "pop", label: "Pop" },
                    { value: "typewriter", label: "Typewriter" },
                    { value: "words", label: "Word by word" },
                    { value: "word", label: "One word at a time" },
                  ]}
                />
              </Row>
              {clip.animation.preset !== "none" && (
                <>
                  <Row label="Duration">
                    <Scrub
                      value={clip.animation.duration}
                      min={1}
                      suffix="f"
                      onStart={begin}
                      onEnd={end}
                      onChange={(value) => update((live) => live.type === "text" && (live.animation.duration = value))}
                    />
                  </Row>
                  {clip.animation.preset !== "fade" && (
                    <Row label="Stagger">
                      <Scrub
                        value={clip.animation.stagger}
                        min={0}
                        step={0.1}
                        precision={1}
                        suffix="f"
                        onStart={begin}
                        onEnd={end}
                        onChange={(value) => update((live) => live.type === "text" && (live.animation.stagger = value))}
                      />
                    </Row>
                  )}
                </>
              )}
            </Section>
            {transform}
          </>
        )}
        {clip.type === "video" && transform}
        {clip.type === "adjustment" && (
          <Section title="Shake">
            <Row label="Preset">
              <Select<ShakePreset>
                value={clip.shake?.preset ?? "none"}
                onChange={(preset) =>
                  // A preset brings its own numbers: drop any set by hand (and amount keyframes).
                  once((live) => {
                    if (live.type !== "adjustment") return;
                    live.shake = { preset };
                    if (live.keyframes) delete live.keyframes.shake;
                  })
                }
                options={(Object.keys(SHAKE_PRESETS) as ShakePreset[]).map((value) => ({ value, label: SHAKE_PRESETS[value].label }))}
              />
            </Row>
            <Row label="Motion">
              <Select<ShakeMotion>
                value={resolvedShake(clip.shake).motion}
                onChange={(motion) => once((live) => live.type === "adjustment" && (live.shake = { ...live.shake, motion }))}
                options={[
                  { value: "wiggle", label: "Wiggle" },
                  { value: "drop", label: "Drop (one fast move)" },
                ]}
              />
            </Row>
            {param("Amount", "shake", { step: 1, min: resolvedShake(clip.shake).motion === "drop" ? -2000 : 0, max: 2000, precision: 0, suffix: "px" })}
            {field("Frequency", resolvedShake(clip.shake).frequency, (live, value) => live.type === "adjustment" && (live.shake = { ...live.shake, frequency: value }), {
              step: 0.1,
              min: 0,
              max: 60,
              precision: 1,
              suffix: "/s",
            })}
            {field("Tilt", resolvedShake(clip.shake).rotation, (live, value) => live.type === "adjustment" && (live.shake = { ...live.shake, rotation: value }), {
              step: 0.05,
              min: 0,
              max: 20,
              precision: 2,
              suffix: "°",
            })}
            {field("Motion blur", resolvedShake(clip.shake).motion_blur, (live, value) => live.type === "adjustment" && (live.shake = { ...live.shake, motion_blur: value }), {
              step: 0.05,
              min: 0,
              max: 4,
              precision: 2,
              suffix: "fr",
            })}
            <Row label="Envelope">
              <Select<ShakeEnvelope>
                value={resolvedShake(clip.shake).envelope}
                onChange={(envelope) => once((live) => live.type === "adjustment" && (live.shake = { ...live.shake, envelope }))}
                options={[
                  { value: "steady", label: "Steady" },
                  { value: "build", label: "Build into the end" },
                  { value: "hit", label: "Hit, then die away" },
                  { value: "swell", label: "Swell" },
                ]}
              />
            </Row>
            <Row label="Edges">
              <Select<ShakeEdges>
                value={resolvedShake(clip.shake).edges}
                onChange={(edges) => once((live) => live.type === "adjustment" && (live.shake = { ...live.shake, edges }))}
                options={[
                  { value: "mirror", label: "Mirror" },
                  { value: "zoom", label: "Zoom to hide" },
                ]}
              />
            </Row>
            <Row label="Direction">
              <Select<ShakeDirection>
                value={resolvedShake(clip.shake).direction}
                onChange={(direction) => once((live) => live.type === "adjustment" && (live.shake = { ...live.shake, direction }))}
                options={[
                  { value: "both", label: "Both" },
                  { value: "vertical", label: "Vertical" },
                  { value: "horizontal", label: "Horizontal" },
                ]}
              />
            </Row>
          </Section>
        )}
        {clip.type === "adjustment" && (
          <Section title="Grade">
            {param("Exposure", "exposure", {
              step: 0.01,
              min: -5,
              max: 5,
              precision: 2,
              suffix: "ev",
            })}
            {param("Contrast", "contrast", {
              step: 0.01,
              min: -1,
              max: 1,
              precision: 2,
            })}
            {param("Saturation", "saturation", {
              step: 0.01,
              min: -1,
              max: 1,
              precision: 2,
            })}
            {param("Temperature", "temperature", {
              step: 0.01,
              min: -1,
              max: 1,
              precision: 2,
            })}
            {param("Vignette", "vignette", {
              step: 0.01,
              min: 0,
              max: 1,
              precision: 2,
            })}
            {param("Mix", "opacity", {
              step: 0.5,
              min: 0,
              max: 100,
              suffix: "%",
              scale: 100,
            })}
          </Section>
        )}
        {clip.type === "adjustment" && (
          <Section title="Blur">
            {param("Strength", "blur", { step: 0.5, min: 0, max: 200, precision: 1, suffix: "px" })}
            {(clip.blur?.radius ?? 0) > 0 && (
              <>
                {param("Center X", "blur.x")}
                {param("Center Y", "blur.y")}
                {param("Width", "blur.width", { min: 0, suffix: "px" })}
                {param("Height", "blur.height", { min: 0, suffix: "px" })}
                {field("Feather", clip.blur?.feather ?? 0, (live, value) => live.type === "adjustment" && (live.blur = { radius: 0, ...live.blur, feather: value }), { min: 0, suffix: "px" })}
                <Row label="Shape">
                  <Select<"ellipse" | "rect">
                    value={clip.blur?.shape ?? "ellipse"}
                    options={[
                      { value: "ellipse", label: "Ellipse" },
                      { value: "rect", label: "Rectangle" },
                    ]}
                    onChange={(shape) => once((live) => live.type === "adjustment" && (live.blur = { radius: 0, ...live.blur, shape }))}
                  />
                </Row>
              </>
            )}
          </Section>
        )}
        {clip.type === "waveform" && (
          <>
            <Section title="Waveform">
              <Row label="Style">
                <Select<"line" | "bars">
                  value={clip.style.kind ?? "line"}
                  options={[
                    { value: "line", label: "Tangled line" },
                    { value: "bars", label: "Bars" },
                  ]}
                  onChange={(kind) => once((live) => live.type === "waveform" && (live.style.kind = kind))}
                />
              </Row>
              <Row label="Color">
                <ColorField value={clip.style.color} onChange={(color) => once((live) => live.type === "waveform" && (live.style.color = color))} />
              </Row>
              {(clip.style.kind ?? "line") === "bars"
                ? field("Bars", clip.style.bars, (live, value) => live.type === "waveform" && (live.style.bars = Math.round(value)), { min: 1, max: 512 })
                : field("Strands", clip.style.strands ?? 3, (live, value) => live.type === "waveform" && (live.style.strands = Math.round(value)), { min: 1, max: 8 })}
              {field("Width", clip.style.width, (live, value) => live.type === "waveform" && (live.style.width = value), { min: 1, suffix: "px" })}
              {field("Height", clip.style.height, (live, value) => live.type === "waveform" && (live.style.height = value), { min: 1, suffix: "px" })}
              {(clip.style.kind ?? "line") === "bars" &&
                field("Bar width", clip.style.fill, (live, value) => live.type === "waveform" && (live.style.fill = value), {
                  step: 0.5,
                  min: 5,
                  max: 100,
                  suffix: "%",
                  scale: 100,
                })}
              {field("Time shown", clip.style.window, (live, value) => live.type === "waveform" && (live.style.window = value), {
                step: 0.05,
                min: 0.1,
                max: 10,
                precision: 2,
                suffix: "s",
              })}
              {param("Sensitivity", "gain", { step: 0.01, min: 0, max: 10, precision: 2, suffix: "×" })}
              {param("Opacity", "opacity", { step: 0.5, min: 0, max: 100, suffix: "%", scale: 100 })}
            </Section>
            <Section
              title="Glow"
              aside={
                <Switch
                  checked={clip.style.glow.enabled}
                  onChange={(enabled) => once((live) => live.type === "waveform" && (live.style.glow.enabled = enabled))}
                />
              }
            >
              {clip.style.glow.enabled && (
                <>
                  <Row
                    label="Color"
                    keyframe={
                      clip.style.glow.color ? (
                        <button
                          title="Match the waveform colour"
                          onClick={() => once((live) => live.type === "waveform" && (live.style.glow.color = null))}
                          className="text-faint transition-colors hover:text-fg"
                        >
                          <RotateCcw size={11} />
                        </button>
                      ) : undefined
                    }
                  >
                    <ColorField
                      value={clip.style.glow.color ?? clip.style.color}
                      label={clip.style.glow.color ? undefined : "Waveform"}
                      onChange={(color) => once((live) => live.type === "waveform" && (live.style.glow.color = color))}
                    />
                  </Row>
                  {param("Blur", "glow.radius", { min: 0, max: 200, suffix: "px" })}
                  {param("Opacity", "glow.strength", { step: 0.5, min: 0, max: 100, suffix: "%", scale: 100 })}
                </>
              )}
            </Section>
            {transform}
          </>
        )}
        {clip.type === "solid" && (
          <Section title="Fill">
            <Row label="Color">
              <ColorField value={clip.fill} onChange={(fill) => once((live) => live.type === "solid" && (live.fill = fill))} />
            </Row>
            {param("Opacity", "opacity", {
              step: 0.5,
              min: 0,
              max: 100,
              suffix: "%",
              scale: 100,
            })}
          </Section>
        )}
        {clip.type === "audio" && (
          <Section title="Audio">
            {param("Volume", "volume_db", {
              step: 0.1,
              min: -60,
              max: 24,
              precision: 1,
              suffix: "dB",
            })}
          </Section>
        )}

        <Section title="Timing">
          <Row label="Start">
            <span className="px-1.5 font-mono text-[12px] text-muted tabular">{timecode(clip.start, fps)}</span>
          </Row>
          <Row label="Duration">
            <Scrub
              value={clip.duration / fps}
              min={1 / fps}
              max={longest(project, clip) / fps}
              step={1 / fps}
              precision={2}
              suffix="s"
              onStart={begin}
              onEnd={end}
              onChange={(value) => useEditor.getState().gesture((draft) => setDuration(draft, [clip.id], value * fps))}
            />
          </Row>
          {(clip.type === "video" || clip.type === "audio") && (
            <Row label="Speed">
              <Scrub
                value={clip.speed * 100}
                min={5}
                max={2000}
                suffix="%"
                onStart={begin}
                onEnd={end}
                onChange={(value) => useEditor.getState().gesture((draft) => setSpeed(draft, [clip.id], value / 100))}
              />
            </Row>
          )}
          <Row label="Fade in">
            <Scrub
              value={clip.fade_in}
              min={0}
              max={clip.duration}
              suffix="f"
              onStart={begin}
              onEnd={end}
              onChange={(value) => update((live) => (live.fade_in = Math.round(value)))}
            />
          </Row>
          <Row label="Fade out">
            <Scrub
              value={clip.fade_out}
              min={0}
              max={clip.duration}
              suffix="f"
              onStart={begin}
              onEnd={end}
              onChange={(value) => update((live) => (live.fade_out = Math.round(value)))}
            />
          </Row>
        </Section>
      </div>
    </>
  );
}

function Many({ clips }: { clips: Clip[] }) {
  const edit = useEditor((state) => state.edit);
  const select = useEditor((state) => state.select);
  const ids = new Set(clips.map((clip) => clip.id));
  return (
    <>
      <Header icon={<Film size={14} />} title={`${clips.length} clips`} />
      <div className="p-3">
        <Button
          variant="danger"
          size="sm"
          onClick={() => {
            edit((draft) => deleteClips(draft, ids));
            select([]);
          }}
        >
          <Trash2 size={13} /> Delete clips
        </Button>
      </div>
    </>
  );
}

function ProjectInfo({ project }: { project: Project }) {
  const fps = project.settings.fps;
  return (
    <>
      <Header icon={<Clapperboard size={14} />} title="Project" color="#8f8f8f" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section title="Sequence">
          <Row label="Resolution">
            <span className="px-1.5 text-[12px] tabular">
              {project.settings.width} × {project.settings.height}
            </span>
          </Row>
          <Row label="Frame rate">
            <span className="px-1.5 text-[12px] tabular">{fps} fps</span>
          </Row>
          <Row label="Duration">
            <span className="px-1.5 font-mono text-[12px] tabular">{timecode(projectDuration(project), fps)}</span>
          </Row>
          <Row label="Clips">
            <span className="px-1.5 text-[12px] tabular">{project.clips.length}</span>
          </Row>
        </Section>
        <div className="px-3 py-2.5">
          <button
            onClick={() => openDialog("shortcuts")}
            className="flex h-7 w-full items-center justify-between rounded-md px-1.5 text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            Keyboard shortcuts
            <Kbd>?</Kbd>
          </button>
        </div>
      </div>
    </>
  );
}
