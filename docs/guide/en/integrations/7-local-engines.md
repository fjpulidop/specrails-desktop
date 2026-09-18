# Local AI engines

Run Specrails on models you host yourself — Ollama, llama.cpp, LM Studio, vLLM or any server that speaks the OpenAI chat-completions API. Once connected, a local endpoint is an engine like any other: it shows up in the rail header, Add Spec (Quick and Explore), the sidebar chat and agent missions.

## Connect an endpoint

1. Open **Settings ▸ Specrails Agents ▸ Provider connections** and choose **Add local engine**.
2. Enter an id, the base URL (for example `http://127.0.0.1:11434/v1`) and, if your server needs a key, the **name of the environment variable** that holds it. The key is never stored — Specrails reads it from the app's environment when it starts a run.
3. Press **Test connection**. The pill turns green when the server answers and the models it serves are listed. Pick a default model.
4. **Save**. The engine is available right away — no restart.

> Launching the app from Finder, the Dock or the Start menu does not inherit shell exports. If the card says the variable is *not set in the app process*, set it system-wide or start the app from a terminal that has it. Servers without a key need nothing.

Each connection also has an **Agent loop** setting. **Compact** (default) drives small models through short structured steps and is what makes a 7–14B model get through implement; **Free** is the classic single agent loop for strong (~30B+) models. Set the **context window** to your server's real size so Specrails compacts before the server rejects a request.

## What you get

- Rails (implement, batch, freestyle, custom loops), Explore and Quick specs, chat and missions all run on the local model.
- Missions keep their Specrails tools and your external MCP servers.
- Sessions resume across turns; interactive jobs work.
- Cost is honest: tokens are recorded, cost stays *unknown* unless you enter rates (then it is marked *estimated*).

Not available on local engines: agent profiles and custom roles, SMASH / Contract Layer enrichment, Project Builder generation, attachments and pipeline telemetry.

> Missions need a **large context window** on the server (64k tokens or more): the operator prompt plus the Specrails tool schemas are big. Chat and Explore are fine at 32k. If a turn fails with *exceeds the available context size*, raise the window (Ollama `OLLAMA_CONTEXT_LENGTH`, llama.cpp `-c`, LM Studio *Context Length*).

## Choosing a model

Quality depends on the model, not on Specrails. For rails use a tool-calling-tuned coder model of 30B parameters or more; smaller instruct models are fine for chat, Explore and Quick specs. Try **Freestyle** or an Explore session before trusting a full implement rail to a new model.

## Turning it off

Set `SPECRAILS_LOCAL_ENGINES=false` in the app environment to hide local engines everywhere. Saved connections are kept and still work as per-role providers of the programmatic runtime.
