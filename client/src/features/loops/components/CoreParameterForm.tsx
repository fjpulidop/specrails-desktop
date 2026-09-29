import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, X } from 'lucide-react'
import { asObject, parameterDefault, schemaType, type ParameterSchema } from '../lib/core-authoring'

const inputClass =
  'w-full min-w-0 rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary'
export interface ParameterChoices {
  providers?: string[]
  roles?: string[]
  components?: string[]
  models?: Record<string, string[]>
  selectedProvider?: string
}
interface Props {
  schema: ParameterSchema
  value: unknown
  onChange(value: unknown): void
  path?: string
  choices?: ParameterChoices
  depth?: number
}

/** Recursive forms cover the Core parameter schema, including arrays and dictionary values. */
export function CoreParameterForm({
  schema,
  value,
  onChange,
  path = 'params',
  choices = {},
  depth = 0,
}: Props) {
  const { t } = useTranslation('loops')
  const id = useId()
  const [newKey, setNewKey] = useState('')
  if (depth > 24)
    return (
      <p role="alert" className="text-xs text-destructive">
        {t('builder.core.tooDeep')}
      </p>
    )
  const label = typeof schema.title === 'string' ? schema.title : path.split('.').slice(-1)[0]
  const child = (
    key: string,
    childSchema: ParameterSchema,
    childValue: unknown,
    change: (value: unknown) => void,
  ) => (
    <CoreParameterForm
      key={key}
      schema={childSchema}
      value={childValue}
      onChange={change}
      path={`${path}.${key}`}
      choices={{
        ...choices,
        selectedProvider:
          typeof asObject(value).provider === 'string'
            ? String(asObject(value).provider)
            : choices.selectedProvider,
      }}
      depth={depth + 1}
    />
  )
  const alternatives = schema.oneOf ?? schema.anyOf
  if (Array.isArray(alternatives) && !schema.properties) {
    const variants = alternatives.map(asObject)
    const selected = Math.max(
      0,
      variants.findIndex((variant) =>
        'const' in variant
          ? value === variant.const
          : Array.isArray(variant.enum)
            ? variant.enum.includes(value)
            : schemaType(variant) === (Array.isArray(value) ? 'array' : typeof value),
      ),
    )
    return (
      <fieldset className="space-y-2">
        <legend className="text-xs font-medium">{label}</legend>
        <label className="sr-only" htmlFor={id}>
          {t('builder.core.variant', { name: label })}
        </label>
        <select
          id={id}
          className={inputClass}
          value={selected}
          onChange={(event) => onChange(parameterDefault(variants[Number(event.target.value)]))}
        >
          {variants.map((variant, index) => (
            <option key={index} value={index}>
              {String(
                variant.title ??
                  variant.const ??
                  (Array.isArray(variant.enum) ? variant.enum.join(' / ') : schemaType(variant)),
              )}
            </option>
          ))}
        </select>
        {child('value', variants[selected], value, onChange)}
      </fieldset>
    )
  }
  if ('const' in schema)
    return (
      <p className="text-xs">
        <span className="text-muted-foreground">{label}: </span>
        {String(schema.const)}
      </p>
    )
  if (Array.isArray(schema.enum))
    return (
      <label className="block space-y-1 text-xs">
        {label}
        <select
          className={inputClass}
          value={JSON.stringify(value)}
          onChange={(event) => onChange(JSON.parse(event.target.value))}
        >
          {!schema.enum.includes(value) && (
            <option value={JSON.stringify(value) ?? ''}>{t('builder.core.select')}</option>
          )}
          {schema.enum.map((option, index) => (
            <option key={index} value={JSON.stringify(option)}>
              {String(option)}
            </option>
          ))}
        </select>
      </label>
    )
  const type = schemaType(schema)
  if (type === 'object') {
    const current = asObject(value),
      properties = asObject(schema.properties)
    const required = new Set(Array.isArray(schema.required) ? schema.required : [])
    const keys = [...Object.keys(properties), ...Object.keys(current).filter((key) => !(key in properties))]
    const set = (key: string, next: unknown) => {
      const updated = { ...current }
      if (key === 'provider' && next !== current.provider && properties.model) { delete updated.model; delete updated.effort }
      if (next === undefined) delete updated[key]
      else
        Object.defineProperty(updated, key, {
          value: next,
          enumerable: true,
          configurable: true,
          writable: true,
        })
      onChange(updated)
    }
    // Core uses object-level oneOf for mutually exclusive text/native and argv/commandLine.
    const exclusive = Array.isArray(alternatives)
      ? alternatives
          .map((alternative) => asObject(alternative).required)
          .filter(
            (keys): keys is string[] => Array.isArray(keys) && keys.every((key) => typeof key === 'string'),
          )
      : []
    const add = (key: string) => {
      const next = { ...current }
      if (exclusive.some((keys) => keys.includes(key)))
        for (const keys of exclusive) for (const other of keys) if (other !== key) delete next[other]
      Object.defineProperty(next, key, {
        value: parameterDefault(asObject(properties[key] ?? schema.additionalProperties)),
        enumerable: true,
        configurable: true,
        writable: true,
      })
      onChange(next)
    }
    return (
      <fieldset className="space-y-2 min-w-0">
        <legend className="text-xs font-semibold text-foreground mb-1">{label}</legend>
        {keys.map((key) => {
          const present = Object.prototype.hasOwnProperty.call(current, key),
            mandatory = required.has(key)
          if (!present && !mandatory)
            return (
              <button
                key={key}
                type="button"
                className="inline-flex items-center gap-1 text-xs rounded border border-border px-2 py-1 mr-1 hover:bg-muted"
                onClick={() => add(key)}
                aria-label={t('builder.core.addField', { name: key })}
              >
                <Plus className="h-3 w-3" />
                {key}
              </button>
            )
          return (
            <div key={key} className="relative border-l border-border pl-2 space-y-1">
              {!mandatory && (
                <button
                  type="button"
                  className="float-right text-muted-foreground hover:text-destructive"
                  onClick={() => set(key, undefined)}
                  aria-label={t('builder.core.removeField', { name: key })}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
              {child(key, asObject(properties[key] ?? schema.additionalProperties), current[key], (next) =>
                set(key, next),
              )}
            </div>
          )
        })}
        {schema.additionalProperties !== false && (
          <div className="flex items-center gap-1">
            <input
              className={inputClass}
              value={newKey}
              placeholder={t('builder.core.fieldName')}
              aria-label={t('builder.core.fieldName')}
              onChange={(event) => setNewKey(event.target.value)}
            />
            <button
              type="button"
              className="p-1.5 text-accent-primary disabled:opacity-40"
              disabled={
                !newKey.trim() ||
                Object.prototype.hasOwnProperty.call(current, newKey.trim()) ||
                ['__proto__', 'constructor', 'prototype'].includes(newKey.trim())
              }
              onClick={() => {
                add(newKey.trim())
                setNewKey('')
              }}
              aria-label={t('builder.core.addField', { name: newKey })}
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
        )}
      </fieldset>
    )
  }
  if (type === 'array') {
    const current = Array.isArray(value) ? value : [],
      itemSchema = asObject(schema.items)
    return (
      <fieldset className="space-y-2">
        <legend className="text-xs font-semibold">{label}</legend>
        {current.map((item, index) => (
          <div key={index} className="border-l border-border pl-2">
            <button
              type="button"
              className="float-right text-muted-foreground hover:text-destructive"
              onClick={() => onChange(current.filter((_, position) => position !== index))}
              aria-label={t('builder.core.removeField', { name: `${label} ${index + 1}` })}
            >
              <X className="h-3.5 w-3.5" />
            </button>
            {child(String(index + 1), itemSchema, item, (next) =>
              onChange(current.map((previous, position) => (position === index ? next : previous))),
            )}
          </div>
        ))}
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs text-accent-primary"
          disabled={typeof schema.maxItems === 'number' && current.length >= schema.maxItems}
          onClick={() => onChange([...current, parameterDefault(itemSchema)])}
        >
          <Plus className="h-3 w-3" />
          {t('builder.core.addItem')}
        </button>
      </fieldset>
    )
  }
  if (!Object.keys(schema).length) {
    const valueType = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    const selected = ['object', 'array', 'boolean', 'number', 'null'].includes(valueType)
      ? valueType
      : 'string'
    return (
      <div className="space-y-1">
        <label className="text-xs">
          {t('builder.core.valueType')}
          <select
            className={inputClass}
            value={selected}
            onChange={(event) =>
              onChange(event.target.value === 'null' ? null : parameterDefault({ type: event.target.value }))
            }
          >
            {['string', 'number', 'boolean', 'object', 'array', 'null'].map((kind) => (
              <option key={kind}>{kind}</option>
            ))}
          </select>
        </label>
        {selected === 'null' ? (
          <span className="text-xs">null</span>
        ) : (
          child('value', { type: selected }, value, onChange)
        )}
      </div>
    )
  }
  if (type === 'boolean')
    return (
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
          className="accent-accent-primary"
        />
        {label}
      </label>
    )
  if (type === 'number' || type === 'integer')
    return (
      <label className="block space-y-1 text-xs">
        {label}
        <input
          type="number"
          className={inputClass}
          value={typeof value === 'number' ? value : ''}
          min={typeof schema.minimum === 'number' ? schema.minimum : undefined}
          max={typeof schema.maximum === 'number' ? schema.maximum : undefined}
          step={type === 'integer' ? 1 : 'any'}
          onChange={(event) => onChange(event.target.value === '' ? undefined : Number(event.target.value))}
        />
      </label>
    )
  const options =
    label === 'provider'
      ? choices.providers
      : label === 'roleId'
        ? choices.roles
        : ['ref', 'body'].includes(label)
          ? choices.components
          : undefined
  const models = label === 'model' ? choices.models?.[choices.selectedProvider ?? ''] : undefined
  const multiline = [
    'text',
    'prompt',
    'question',
    'message',
    'goal',
    'expr',
    'commandLine',
    'reason',
  ].includes(label)
  return (
    <label className="block space-y-1 text-xs">
      {label}
      {options?.length ? (
        <select
          className={inputClass}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">{t('builder.core.select')}</option>
          {value && !options.includes(String(value)) ? (
            <option value={String(value)}>{String(value)}</option>
          ) : null}
          {options.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      ) : multiline ? (
        <textarea
          className={`${inputClass} min-h-24 resize-y font-mono`}
          value={typeof value === 'string' ? value : ''}
          maxLength={typeof schema.maxLength === 'number' ? schema.maxLength : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          list={models?.length ? id : undefined}
          className={inputClass}
          value={typeof value === 'string' ? value : ''}
          maxLength={typeof schema.maxLength === 'number' ? schema.maxLength : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {models?.length ? (
        <datalist id={id}>
          {models.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
      ) : null}
      {typeof schema.description === 'string' && (
        <span className="text-[10px] text-muted-foreground">{schema.description}</span>
      )}
    </label>
  )
}
