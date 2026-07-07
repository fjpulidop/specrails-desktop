## MODIFIED Requirements

### Requirement: Star Wars palette definition

The `star-wars` theme SHALL define a neutral deep-space near-black background, a Jedi-blue accent shared by `accent-primary`, `ring`, and `accent-info`, an Imperial steel-gray/silver `accent-secondary`, a Sith-red `destructive` accent, a gold `accent-highlight`, and a Force-green `accent-success`, plus a full xterm terminal palette, a 5-color Recharts chart palette, and job-status colors, following the exact `ThemeDescriptor` shape used by every other built-in theme. The Star Wars palette MUST be visually distinct from the `specrails` theme: its background MUST be substantially less saturated than SpecRails's navy-indigo near-black, its secondary accent MUST NOT use the SpecRails violet hue family, and its primary blue MUST be hue-separated from SpecRails's cyan primary.

#### Scenario: Star Wars descriptor defines all required fields
- **WHEN** `THEMES['star-wars']` is inspected
- **THEN** it has `displayName`, `tagline`, `scheme: 'dark'`, `previewSwatches`, a full 20-key `xterm` palette, a 5-entry `chart` palette with unique colors, and a `status` map covering `completed`, `failed`, `canceled`, `running`, and `queued`

#### Scenario: Primary, ring, and info share a distinct Jedi-blue hue
- **WHEN** the active theme is `star-wars`
- **THEN** `accent-primary`, `ring`, and `accent-info` all resolve to the same blue hue in the 212-215 degree range, distinct from the resolved `destructive` red, `accent-highlight` gold, `accent-success` green, and SpecRails cyan primary hues

#### Scenario: Background is neutral deep-space black, not SpecRails navy
- **WHEN** the active theme is `star-wars`
- **THEN** the resolved background is a desaturated near-black with saturation around 20% and lightness around 4%, preserving a dark elevation ladder while reading as neutral black rather than SpecRails's saturated navy-indigo

#### Scenario: Secondary is Imperial steel-gray, not violet
- **WHEN** the active theme is `star-wars`
- **THEN** `accent-secondary` resolves to a low-saturation cool steel-gray/silver hue around 210 degrees and does not overlap with SpecRails's violet secondary hue family

#### Scenario: Destructive is an unmistakable Sith red
- **WHEN** the active theme is `star-wars`
- **THEN** the resolved `destructive` / `accent-destructive`-equivalent hue sits in the red band (hue 340-10 degrees), distinct from the gold highlight and the blue primary
