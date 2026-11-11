# project-builder-ux-review Specification

## Purpose
Definir una auditoría trazable del Project Builder y una propuesta de revisión UX que permita acordar cambios seguros antes de implementarlos.

## Requirements

### Requirement: Cobertura completa con límites explícitos
El informe SHALL mapear creación, blueprint, generación de milestones, lanzamiento, seguimiento, revisión y aceptación. Cada recorrido SHALL identificar superficies, estados, acciones, navegación y límites de verificación, sin dar por defectuoso un recorrido por no haberlo reproducido.

#### Scenario: Recorrido y continuidad documentados
- **WHEN** se entrega el mapa de auditoría
- **THEN** cada etapa identifica sus superficies reales, estados vacíos, carga, error, bloqueo y continuidad al reabrir o cambiar de proyecto, señalando lo comprobado y lo pendiente

#### Scenario: Evaluación de interacción y presentación
- **WHEN** se registra la cobertura de una superficie
- **THEN** consta la evaluación o limitación explícita de jerarquía visual, legibilidad, desbordamiento, teclado, foco y nombres accesibles

### Requirement: Hallazgos sustentados y clasificados
Cada hallazgo SHALL incluir escenario, evidencia localizable, impacto, severidad, resultado esperado y certeza. El informe SHALL separar reproducción observada, conclusión del código e hipótesis, incluyendo comprobaciones no disponibles y ausencia de evidencia.

#### Scenario: Código sin reproducción visual
- **WHEN** un hallazgo procede de una condición del código sin reproducción de la interfaz
- **THEN** queda identificado como análisis de código y no se afirma una reproducción ni una medición de usuarios

### Requirement: Diagnóstico comparativo de BUG-02
El informe SHALL documentar la restricción a M1 y comparar M1 con milestones posteriores para estados sin entregas, parciales, parciales con rail manual activo, cadena activa, pausada, checkpoint, sin pendientes y entregas pendientes de aceptación. SHALL seguir el lanzamiento desde la interfaz hasta las validaciones del servidor.

#### Scenario: Matriz de lanzamiento completa
- **WHEN** se entrega el diagnóstico de BUG-02
- **THEN** cada estado tiene comportamiento actual y esperado para M1 y M2+, evidencia, incertidumbres y distinción entre iniciar cadena, continuarla y revisar entregas

### Requirement: Conservación del trabajo y alcance de los bloqueos
El análisis SHALL identificar elegibilidad de specs, dependencias y bases de integración tras entregas manuales, riesgos de duplicación y alcance comprobado de bloqueos por spec, milestone, repositorio o proyecto. Las garantías no verificadas SHALL quedar como riesgos, conservando la distinción entre entregado, pendiente de aceptación y aceptado.

#### Scenario: Entrega manual anterior
- **WHEN** un milestone tiene specs ya entregadas y specs pendientes
- **THEN** la propuesta excluye las entregadas de la nueva ejecución y explica cómo comprobar la incorporación de sus dependencias y bases, sin atribuir garantías no demostradas al servidor

#### Scenario: Rail manual activo
- **WHEN** existe un rail manual activo durante una entrega parcial
- **THEN** el informe distingue solapamiento de specs y otros bloqueos comprobados de una mera coincidencia de milestone o repositorio; la propuesta mantiene visible la acción deshabilitada con motivo cuando un rail impide lanzar

### Requirement: Auto-avance y antecedentes trazables
El informe SHALL registrar el auto-avance efectivo en cliente y servidor, su preferencia persistida y su discrepancia con el antecedente histórico. SHALL documentar dónde y con qué términos se buscó la revisión UX del 1 de noviembre y declarar si no se localiza. La auditoría SHALL mantener el valor por defecto actual.

#### Scenario: Preferencia ausente o guardada
- **WHEN** se documenta el auto-avance
- **THEN** se describe el comportamiento sin preferencia, con preferencia false y true, el valor omitido en servidor y el efecto de activarlo en checkpoint, separando comportamiento actual de decisión futura

### Requirement: Propuesta priorizada pendiente de revisión
La propuesta SHALL incluir prioridades, límites, dependencias, riesgos, criterios observables, secuencia de implementación revisable y validación por cambio. Para BUG-02 SHALL contemplar Lanzar restantes y auto-avance en milestones listos con entregas parciales, con tests de componente de sin entregas, parcial y parcial con rail manual activo y validación del servidor cuando corresponda.

#### Scenario: Secuencia lista para decisión
- **WHEN** se presenta la propuesta
- **THEN** sus cambios están priorizados y vinculados a hallazgos y escenarios de validación, sin presentar la revisión del usuario ni la implementación como aprobadas

### Requirement: Auditoría sin efectos en proyectos reales
La entrega SHALL producir documentación y propuestas sin cambios funcionales o visuales, modificación de datos reales, alteración de entregas ni pipelines de pago. Las reproducciones SHALL usar fixtures o entornos de prueba existentes cuando estén disponibles y registrar las limitaciones restantes.

#### Scenario: Reproducción no disponible de forma segura
- **WHEN** comprobar un estado requeriría modificar un proyecto real o ejecutar un proveedor de pago
- **THEN** se documenta el límite y el escenario de prueba aislado necesario, sin ejecutar la operación real
