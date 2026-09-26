import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2 } from 'lucide-react'
import { asObject } from '../lib/core-authoring'
import type { LoopNodeData } from '../lib/loop-graph-rf'
import type { LoopGraph, WorkflowPieceDescriptor } from '../lib/loops-api'
import { CoreParameterForm, type ParameterChoices } from './CoreParameterForm'

const fieldClass = 'w-full min-w-0 rounded border border-border bg-background px-2 py-1 text-xs'
const OPTION_KEYS = ['journal', 'change', 'maxTokens', 'maxTransitions', 'policies']

export function CoreWorkflowInspector({
  graph,
  canvas,
  schema,
  onChange,
  onOpenCanvas,
}: {
  graph: LoopGraph
  canvas: string | null
  schema: Record<string, unknown>
  onChange(graph: LoopGraph): void
  onOpenCanvas(name: string, create?: boolean): void
}) {
  const { t } = useTranslation('loops')
  const [name, setName] = useState('')
  const properties = asObject(schema.properties)
  const optionsSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      ...Object.fromEntries(
        OPTION_KEYS.filter((key) => properties[key]).map((key) => [key, properties[key]]),
      ),
      ...(asObject(asObject(properties.budget).properties).maxTokens
        ? { maxTokens: asObject(asObject(properties.budget).properties).maxTokens }
        : {}),
    },
  }
  const options = Object.fromEntries(
    Object.entries(graph.config).filter(([key]) => OPTION_KEYS.includes(key)),
  )
  const component = canvas ? graph.components?.[canvas] : undefined
  return (
    <>
      <CoreParameterForm
        schema={optionsSchema}
        value={options}
        path={t('builder.core.options')}
        onChange={(value) => {
          const config = Object.fromEntries(
            Object.entries(graph.config).filter(([key]) => !OPTION_KEYS.includes(key)),
          )
          onChange({ ...graph, config: { ...config, ...(value as object) } as LoopGraph['config'] })
        }}
      />
      <section className="space-y-2">
        <p className="text-xs font-semibold">{t('builder.core.components')}</p>
        <div className="flex flex-wrap gap-1">
          {Object.keys(graph.components ?? {}).map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => onOpenCanvas(name)}
              className="text-xs rounded border border-border px-2 py-1 hover:bg-muted"
            >
              {name}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          <input
            className={fieldClass}
            value={name}
            aria-label={t('builder.core.componentName')}
            placeholder={t('builder.core.componentName')}
            onChange={(event) => setName(event.target.value)}
          />
          <button
            type="button"
            disabled={!/^[a-z][a-z0-9-]{0,63}$/.test(name) || !!graph.components?.[name]}
            onClick={() => {
              onOpenCanvas(name, true)
              setName('')
            }}
            aria-label={t('builder.core.addComponent')}
            className="text-accent-primary disabled:opacity-40"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
        {component && canvas && (
          <CoreParameterForm
            schema={{
              type: 'object',
              additionalProperties: false,
              required: ['inputs', 'outputs'],
              properties: {
                inputs: { type: 'array', items: { type: 'string' } },
                outputs: { type: 'array', items: { type: 'string' } },
              },
            }}
            value={{ inputs: component.inputs ?? [], outputs: component.outputs ?? ['next', 'failed'] }}
            path={canvas}
            onChange={(value) => {
              onChange({
                ...graph,
                components: {
                  ...graph.components,
                  [canvas]: { ...component, ...(value as { inputs: string[]; outputs: string[] }) },
                },
              })
            }}
          />
        )}
      </section>
    </>
  )
}

export function CoreNodeInspector({
  nodeId,
  data,
  piece,
  choices,
  schema,
  onChange,
  onDelete,
  onOpenCanvas,
}: {
  nodeId: string
  data: LoopNodeData
  piece?: WorkflowPieceDescriptor
  choices: ParameterChoices
  schema: Record<string, unknown>
  onChange(patch: Partial<LoopNodeData>): void
  onDelete(): void
  onOpenCanvas(name: string): void
}) {
  const { t } = useTranslation('loops')
  const component = data.params?.ref ?? data.params?.body
  const retrySchema = asObject(asObject(schema.$defs).retry)
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{t(`builder.core.pieces.${data.coreKind}`)}</h3>
        <button
          type="button"
          onClick={onDelete}
          aria-label={t('common:actions.delete')}
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      <label className="block text-xs">
        {t('builder.inspector.label')}
        <input
          className={fieldClass}
          value={String(data.label ?? '')}
          onChange={(event) => onChange({ label: event.target.value })}
        />
      </label>
      {piece ? (
        <CoreParameterForm
          key={nodeId}
          schema={piece.paramsSchema}
          value={data.params ?? {}}
          onChange={(value) => onChange({ params: value as Record<string, unknown> })}
          choices={choices}
        />
      ) : (
        <p className="text-xs text-muted-foreground">{t('builder.core.unavailable')}</p>
      )}
      {['component', 'map'].includes(data.coreKind!) && typeof component === 'string' && (
        <button type="button" className="text-xs text-accent-primary" onClick={() => onOpenCanvas(component)}>
          {t('builder.core.openComponent')}
        </button>
      )}
      {Object.keys(retrySchema).length > 0 && (
        <CoreParameterForm
          schema={retrySchema}
          value={data.retry ?? {}}
          path="retry"
          onChange={(value) => onChange({ retry: value })}
        />
      )}
    </div>
  )
}
