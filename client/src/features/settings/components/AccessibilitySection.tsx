import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { HelpHint } from '../../../components/HelpHint'
import { SettingAnchor } from './SettingAnchor'
import { SettingsCard } from './SettingsCard'
import { cn } from '../../../lib/utils'
import {
  setA11yPrefs,
  useA11yPrefs,
  type DensityPref,
  type MotionPref,
} from '../../../lib/a11y-prefs'

// Settings ▸ Appearance ▸ Density and Reduce motion (BB4). Both are per-machine and
// apply at once: the choice is mirrored to <html data-density / data-motion>.

interface ChoiceProps<T extends string> {
  name: string
  legend: string
  value: T
  options: ReadonlyArray<{ value: T; label: string; hint: string }>
  onChange: (next: T) => void
  testId: string
}

function ChoiceGroup<T extends string>({ name, legend, value, options, onChange, testId }: ChoiceProps<T>) {
  const base = useId()
  return (
    <div role="radiogroup" aria-label={legend} className="grid gap-2 sm:grid-cols-3" data-testid={testId}>
      {options.map((opt) => {
        const id = `${base}-${opt.value}`
        const selected = opt.value === value
        return (
          <label
            key={opt.value}
            htmlFor={id}
            className={cn(
              'flex cursor-pointer flex-col gap-0.5 rounded-control border px-3 py-2 transition-colors',
              'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
              selected ? 'border-accent-primary bg-accent-primary/10' : 'border-border/60 hover:border-border',
            )}
          >
            <input
              id={id}
              type="radio"
              name={name}
              value={opt.value}
              checked={selected}
              onChange={() => onChange(opt.value)}
              className="sr-only"
              data-testid={`${testId}-${opt.value}`}
            />
            <span className="text-label">{opt.label}</span>
            <span className="text-caption text-muted-foreground">{opt.hint}</span>
          </label>
        )
      })}
    </div>
  )
}

export function DensitySection() {
  const { t } = useTranslation('settings')
  const { density } = useA11yPrefs()
  return (
    <SettingsCard
      title={t('accessibility.density.title')}
      description={t('accessibility.density.description')}
      action={<HelpHint topic="accessibility" />}
      data-testid="density-section"
    >
      <ChoiceGroup<DensityPref>
        name="app-density"
        legend={t('accessibility.density.title')}
        value={density}
        onChange={(next) => setA11yPrefs({ density: next })}
        testId="density-choice"
        options={[
          { value: 'comfortable', label: t('accessibility.density.comfortable'), hint: t('accessibility.density.comfortableHint') },
          { value: 'compact', label: t('accessibility.density.compact'), hint: t('accessibility.density.compactHint') },
        ]}
      />
    </SettingsCard>
  )
}

export function ReduceMotionSection() {
  const { t } = useTranslation('settings')
  const { motion } = useA11yPrefs()
  return (
    <SettingsCard
      title={t('accessibility.motion.title')}
      description={t('accessibility.motion.description')}
      action={<HelpHint topic="accessibility" />}
      data-testid="reduce-motion-section"
    >
      <ChoiceGroup<MotionPref>
        name="app-motion"
        legend={t('accessibility.motion.title')}
        value={motion}
        onChange={(next) => setA11yPrefs({ motion: next })}
        testId="motion-choice"
        options={[
          { value: 'system', label: t('accessibility.motion.system'), hint: t('accessibility.motion.systemHint') },
          { value: 'reduce', label: t('accessibility.motion.reduce'), hint: t('accessibility.motion.reduceHint') },
          { value: 'full', label: t('accessibility.motion.full'), hint: t('accessibility.motion.fullHint') },
        ]}
      />
    </SettingsCard>
  )
}

/** The two anchored cards, in the Appearance pane. */
export function AccessibilitySettings() {
  return (
    <>
      <SettingAnchor id="density"><DensitySection /></SettingAnchor>
      <SettingAnchor id="reduceMotion"><ReduceMotionSection /></SettingAnchor>
    </>
  )
}
