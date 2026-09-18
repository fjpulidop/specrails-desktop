# Lokale KI-Engines

Betreibe Specrails mit Modellen, die du selbst hostest — Ollama, llama.cpp, LM Studio, vLLM oder jeder Server, der die OpenAI-Chat-Completions-API spricht. Einmal verbunden ist ein lokaler Endpunkt eine Engine wie jede andere: Er erscheint in der Rail-Kopfzeile, in Spec hinzufügen (Quick und Explore), im Seitenleisten-Chat und in Agenten-Missionen.

## Endpunkt verbinden

1. Öffne **Einstellungen ▸ Specrails-Agenten ▸ Provider-Verbindungen** und wähle **Lokale Engine hinzufügen**.
2. Gib eine ID, die Basis-URL (z. B. `http://127.0.0.1:11434/v1`) und, falls dein Server einen Schlüssel braucht, den **Namen der Umgebungsvariable** an, die ihn enthält. Der Schlüssel wird nie gespeichert — Specrails liest ihn beim Start jedes Laufs aus der Umgebung der App.
3. Klicke auf **Verbindung testen**. Die Pille wird grün, sobald der Server antwortet, und die bereitgestellten Modelle werden aufgelistet. Wähle ein Standardmodell.
4. **Speichern**. Die Engine ist sofort verfügbar — kein Neustart nötig.

> Wird die App über Finder, Dock oder Startmenü gestartet, werden Shell-Exports nicht übernommen. Meldet die Karte, die Variable sei *im App-Prozess nicht gesetzt*, setze sie systemweit oder starte die App aus einem Terminal, das sie kennt. Server ohne Schlüssel brauchen nichts davon.

Jede Verbindung hat außerdem die Einstellung **Agenten-Schleife**. **Kompakt** (Standard) führt kleine Modelle durch kurze, strukturierte Schritte – damit schafft ein 7–14B-Modell den Implement-Lauf; **Frei** ist die klassische einzelne Agentenschleife für starke Modelle (~30B+). Setze das **Kontextfenster** auf die echte Größe deines Servers, damit Specrails komprimiert, bevor der Server eine Anfrage ablehnt.

## Was du bekommst

- Rails (implement, batch, freestyle, eigene Loops), Explore und Quick-Specs, Chat und Missionen laufen auf dem lokalen Modell.
- Missionen behalten ihre Specrails-Tools und deine externen MCP-Server.
- Sitzungen werden über Turns hinweg fortgesetzt; interaktive Jobs funktionieren.
- Kosten sind ehrlich: Tokens werden erfasst, die Kosten bleiben *unbekannt*, sofern du keine Tarife einträgst (dann als *geschätzt* markiert).

Auf lokalen Engines nicht verfügbar: Agentenprofile und eigene Rollen, SMASH-/Contract-Layer-Anreicherung, Project-Builder-Generierung, Anhänge und Pipeline-Telemetrie.

> Missionen brauchen ein **großes Kontextfenster** auf dem Server (64k Tokens oder mehr): Operator-Prompt plus Specrails-Tool-Schemas sind umfangreich. Chat und Explore kommen mit 32k aus. Schlägt ein Turn mit *exceeds the available context size* fehl, vergrößere das Fenster (Ollama `OLLAMA_CONTEXT_LENGTH`, llama.cpp `-c`, LM Studio *Context Length*).

## Modell wählen

Die Qualität hängt vom Modell ab, nicht von Specrails. Nutze für Rails ein auf Tool-Calling trainiertes Coder-Modell mit mindestens 30B Parametern; kleinere Instruct-Modelle reichen für Chat, Explore und Quick-Specs. Probiere **Freestyle** oder eine Explore-Sitzung, bevor du einem neuen Modell einen kompletten Implement-Rail anvertraust.

## Abschalten

Setze `SPECRAILS_LOCAL_ENGINES=false` in der App-Umgebung, um lokale Engines überall auszublenden. Gespeicherte Verbindungen bleiben erhalten und gelten weiterhin als Rollen-Provider der programmatischen Runtime.
