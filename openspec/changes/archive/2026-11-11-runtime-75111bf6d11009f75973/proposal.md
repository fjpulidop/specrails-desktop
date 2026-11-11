# Proposal

## Why

El Project Builder tiene una restricción comprobable de lanzamiento a M1 en el popover Blueprint (BUG-02), pero aún no existe un diagnóstico completo de sus recorridos. Hace falta una auditoría con evidencia y una propuesta revisable antes de autorizar cambios funcionales o visuales.

## What Changes

- Entregar un informe de auditoría de creación, blueprint, generación, lanzamiento, seguimiento, revisión y aceptación, incluyendo navegación, recuperación, errores y accesibilidad.
- Documentar BUG-02 con matriz M1/M2+, trazabilidad hasta las validaciones del servidor, elegibilidad de specs y límites de las garantías frente a entregas y rails manuales.
- Proponer una revisión priorizada con Lanzar restantes, auto-avance y acciones bloqueadas visibles con motivo; distinguir recomendaciones de decisiones aprobadas.
- Registrar búsqueda de antecedentes, discrepancia histórica del auto-avance, incertidumbres y plan de validación por propuesta.

## Capabilities

### New Capabilities

- `project-builder-ux-review`: contrato de evidencia, cobertura y propuesta de revisión UX del Builder; describe la entrega de auditoría, no un nuevo comportamiento de ejecución.

### Modified Capabilities

Ninguna. Los contratos existentes `project-builder-entry`, `milestone-launch-chain` y los ciclos de entrega permanecen intactos; la revisión funcional posterior requiere otro cambio acordado.

## Impact

Entrega documental: crear `docs/internals/project-builder-ux-audit.md` y enlazarlo desde `docs/internals/project-builder.md`. Las referencias de código y tests son evidencia de lectura, no autorización para editarlos. Sin APIs, dependencias, migraciones, datos reales, pipelines de pago, cambios de preferencias ni modificaciones visuales. La propuesta queda pendiente de revisión del usuario.