/**
 * Static message catalogs of the v2 MCP surface (bundled: imported, never read from disk).
 *
 * One JSON file per language and area: `<lang>/<area>.json`, flat keys without the
 * area prefix; `t(lang, '<area>.<key>')` reads them. Each work package edits only its
 * own `en/<area>.json`; WP12 adds the other languages (and their imports here).
 * `<lang>/core.json` outside English holds the keys sourced from the app's own client
 * locales (sources.json), kept in sync by i18n.test.ts.
 */
import en_core from './en/core.json'
import en_overview from './en/overview.json'
import en_inbox from './en/inbox.json'
import en_wait from './en/wait.json'
import en_projects from './en/projects.json'
import en_specs from './en/specs.json'
import en_blueprint from './en/blueprint.json'
import en_rails from './en/rails.json'
import en_runs from './en/runs.json'
import en_deliveries from './en/deliveries.json'
import en_missions from './en/missions.json'
import en_insights from './en/insights.json'
import en_settings from './en/settings.json'
import en_providers from './en/providers.json'
import en_integrations from './en/integrations.json'
import en_system from './en/system.json'
import es_core from './es/core.json'
import fr_core from './fr/core.json'
import de_core from './de/core.json'
import pt_core from './pt/core.json'
import it_core from './it/core.json'
import zh_core from './zh/core.json'
import ja_core from './ja/core.json'

export const I18N_AREAS = ['core', 'overview', 'inbox', 'wait', 'projects', 'specs', 'blueprint', 'rails', 'runs', 'deliveries', 'missions', 'insights', 'settings', 'providers', 'integrations', 'system'] as const
export type I18nArea = (typeof I18N_AREAS)[number]

type Messages = Record<string, string>

export const CATALOGS: Record<string, Partial<Record<I18nArea, Messages>>> = {
  en: { core: en_core, overview: en_overview, inbox: en_inbox, wait: en_wait, projects: en_projects, specs: en_specs, blueprint: en_blueprint, rails: en_rails, runs: en_runs, deliveries: en_deliveries, missions: en_missions, insights: en_insights, settings: en_settings, providers: en_providers, integrations: en_integrations, system: en_system },
  es: { core: es_core },
  fr: { core: fr_core },
  de: { core: de_core },
  pt: { core: pt_core },
  it: { core: it_core },
  zh: { core: zh_core },
  ja: { core: ja_core },
}
