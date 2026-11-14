# Prompt para la validación en vivo (Arch Linux)

Copia el bloque de abajo como primer mensaje a Claude Code, abierto en el directorio de este
repositorio en la máquina donde vas a probar. No pegues el token del bot en el chat: los comandos
`init` y `pair` se ejecutan en una terminal aparte.

```text
Estás en el repositorio de telegram-bridge, un channel de Claude Code (servidor MCP por stdio más
hooks) que conecta un chat de Telegram con una sesión local de Claude Code. Los flujos F0 a F13
están implementados y pasan las pruebas automáticas en CI (ubuntu y windows), pero NUNCA se han
probado contra la API real de Telegram ni contra una sesión viva de Claude Code. Estoy en Arch
Linux y voy a hacer esa validación contigo. Respóndeme en español.

Antes de hacer nada, lee en este orden: CLAUDE.md, README.es.md, docs/flows/README.md (el índice y
la lista de validación en vivo, por partes), docs/adr/0005-f0-findings.md, docs/threat-model.md y
docs/roadmap.md. Los detalles de cada flujo están en docs/flows/F<n>.md y las decisiones en
docs/adr/.

Tu trabajo:

1. Preparar el entorno. Comprueba que Bun está instalado y su versión, ejecuta `bun install` y
   luego `bun run check`. Si algo falla en Arch y pasaba en CI, eso ya es un hallazgo: diagnostícalo
   antes de seguir. Dime si mi sesión es Wayland o X11 y qué herramienta de captura hay disponible
   (lo necesita F5).

2. Guiarme, un paso a la vez, por la lista de docs/flows/README.md en su orden. Para cada parte
   dime exactamente qué ejecutar o qué enviar desde el teléfono y qué debería ver. Espera mi
   resultado antes de pasar al siguiente paso. Los pasos que necesitan el token o una terminal
   interactiva (`bun run bridge -- init`, `bun run bridge -- pair`, lanzar
   `claude --dangerously-load-development-channels server:telegram-bridge`) los ejecuto yo en otra
   terminal; nunca me pidas el token ni un código de emparejamiento, y no los escribas en ningún
   archivo, log ni commit.

3. Cuando algo no coincida con lo documentado, diagnostica con evidencia: `claude --debug` para el
   stderr del canal, `TELEGRAM_BRIDGE_DEBUG=1` para los hooks, las filas de auditoría de
   `bridge.sqlite` en el directorio de estado (por defecto `~/.claude/channels/telegram-bridge`),
   y la documentación oficial de Claude Code (https://code.claude.com/docs) antes que tu memoria:
   los channels son una research preview y el contrato puede haber cambiado. Distingue siempre
   entre "el código está mal", "la documentación del proyecto está mal" y "Claude Code cambió".

4. Corregir lo que falle respetando CLAUDE.md: capas de la arquitectura, nada de console.log en
   src/, textos de usuario en src/application/i18n/messages.ts, todo lo saliente por
   buildOutbound(), secretos fuera de logs. Cada corrección lleva su prueba y `bun run check` debe
   pasar. No debilites pruebas ni el chequeo de arquitectura para que algo pase. Una rama y un PR
   por corrección o por grupo coherente de correcciones, con Conventional Commits.

5. Actualizar la documentación con lo que se verifique: marca en docs/flows/README.md cada punto
   comprobado (con fecha, versión de Claude Code y de Bun), corrige en los F<n>.md y ADR lo que
   resulte distinto de lo supuesto, y quita los "necesita verificación en vivo" que ya estén
   resueltos. Presta atención especial a los puntos abiertos conocidos:
   - si Claude Code registra el canal y entrega los mensajes con el SDK MCP 1.x;
   - el relay de permisos (botones Aprobar/Denegar, doble toque en riesgo alto) y que gane la
     primera respuesta entre terminal y teléfono;
   - que `/stop` bloquee la siguiente llamada a herramienta por el hook PreToolUse, y `/resume`;
   - los hooks de avisos (Stop, Notification) y los campos reales de sus payloads;
   - la ruta de instalación como plugin: `--plugin-dir`, la forma exacta del flag de canal para un
     plugin, y si hace falta un marketplace.json;
   - si un `/skill` que llega por el canal se ejecuta como comando de Claude Code (F7);
   - capturas en mi entorno gráfico (F5);
   - el mensaje fijado y la frecuencia de errores 429 al editarlo (F9);
   - `/diff` con sus botones, gráficas, `/wrap` con la aprobación de memoria, archivos entrantes;
   - notas de voz (F13) solo si instalo `whisper-cpp`, `ffmpeg` y un modelo ggml.

Reglas:
- Commits, pushes y PR van a mi nombre, sin "Co-Authored-By" ni ninguna mención de autoría de IA,
  ni en mensajes de commit ni en descripciones de PR. No hagas push ni fusiones sin decírmelo.
- No toques el directorio de estado real más que para leer, salvo que yo lo pida. Las pruebas
  automáticas usan directorios temporales y nunca la API real de Telegram; mantenlo así.
- No trabajes en F14 ni F15. F14 (modo multi-proyecto) quedó pausado, sin terminar y sin revisar,
  en la rama feat/f14-multi-project (PR en borrador; ver docs/flows/F14-WIP.md en esa rama). Se
  retoma solo después de esta validación. F15 no se empieza sin que yo lo decida.
- Si una acción es destructiva o difícil de deshacer, pregúntame antes.

Empieza por el punto 1 y dame un resumen corto de lo que encontraste antes de la primera prueba
en vivo.
```

## Notas

- Clona `main`: contiene F0 a F13. Requisitos e instalación: [README.es.md](../README.es.md).
- Qué probar y en qué orden: [docs/flows/README.md](flows/README.md).
- Para que Claude vea el diagnóstico de los hooks, exporta `TELEGRAM_BRIDGE_DEBUG=1` en la
  terminal donde lanzas la sesión que usa el canal.
- Conviene usar dos sesiones: una con el canal cargado (la que se prueba) y otra normal en el
  repositorio (la que recibe este prompt y corrige), para que reiniciar la primera no corte el
  trabajo de la segunda.
