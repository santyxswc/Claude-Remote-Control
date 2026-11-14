# telegram-bridge

[Read in English](README.md)

Un channel de Claude Code que convierte un chat de Telegram en el control remoto de una sesión de
Claude Code que corre en tu propio PC.

Claude Code se detiene cuando termina una tarea o cuando pide un permiso, y no pasa nada hasta que
alguien vuelve al teclado. `telegram-bridge` te permite dar instrucciones, responder permisos,
recibir avisos de "terminé", ver la pantalla y frenar a Claude desde el teléfono. Tú creas y eres
dueño del bot, y todo corre en tu PC: no hay bot compartido ni un servidor operado por este
proyecto ([ADR 0001](docs/adr/0001-own-bot-per-user.md)).

## Estado

El MVP (flujos F0 a F6) está implementado y cubierto por pruebas automáticas que usan dobles de
Telegram y de Claude Code, más dos pruebas de humo locales para las capturas. **Todavía no se ha
validado de punta a punta contra la API real de Telegram ni contra una sesión viva de Claude
Code.** Varios comportamientos de Claude Code figuran como "necesita verificación en vivo" en los
documentos. La lista para esa validación está en [docs/flows/README.md](docs/flows/README.md).
Considéralo software previo a una versión estable.

Los channels son una research preview de Claude Code: el flag y el protocolo pueden cambiar.

Se agregará una demo después de la validación en vivo.

Licencia: por decidir.

## Qué hace

El MVP tiene seis capacidades:

1. **Mensajes en ambos sentidos.** El texto que envías al bot llega a la sesión; Claude responde con
   la herramienta `reply`. El texto saliente se censa de secretos y se trocea para respetar el
   límite de 4096 caracteres de Telegram ([F2](docs/flows/F2.md)).
2. **Permisos con botones.** Los diálogos de aprobación de herramientas se reenvían al chat con
   botones Aprobar y Denegar. Lo que parece destructivo exige un segundo toque. El diálogo de la
   terminal sigue abierto y gana la primera respuesta que llegue ([F3](docs/flows/F3.md)).
3. **Avisos de "terminé" y "necesito respuesta".** Los hooks de Claude Code avisan al chat cuando
   Claude terminó o espera algo de ti, sin que Claude tenga que llamar a una herramienta
   ([F4](docs/flows/F4.md)).
4. **Capturas a demanda.** `/shot` captura la pantalla y `/shot <url>` una página web. Claude también
   puede enviar una con una herramienta ([F5](docs/flows/F5.md)).
5. **Botón de pánico.** `/stop` hace que un hook `PreToolUse` rechace toda herramienta hasta
   `/resume` ([F6](docs/flows/F6.md)).
6. **Emparejamiento seguro.** Un código de un solo uso, mostrado como QR en la terminal, enlaza tu
   cuenta de Telegram con el PC; tú confirmas en la terminal quién lo envió. Todos los demás son
   ignorados ([F1](docs/flows/F1.md)).

Fuera del MVP (ver [docs/roadmap.md](docs/roadmap.md), en inglés): git desde el chat, mensaje fijado
de estado, fotos y archivos entrantes (hoy los mensajes que no son texto se rechazan), gráficas,
resumen de sesión a memoria, notas de voz, un topic por proyecto y la Mini App con pantalla en
vivo. Contestar llamadas de Telegram queda fuera de alcance: la Bot API no lo permite.

El MVP es un bot para una sola sesión de Claude Code.

## Requisitos

- Claude Code con sesión iniciada con una cuenta de claude.ai o una clave de API de Console. Los
  channels no están disponibles en Amazon Bedrock, Google Cloud's Agent Platform ni Microsoft
  Foundry. En planes Team y Enterprise un administrador debe habilitar los channels
  (`channelsEnabled`). Versión: se recomienda la 2.1.295 o posterior, porque el hook del freno usa
  la clave `onFailure` ([ADR 0003](docs/adr/0003-stop-via-hook.md)); el relay de permisos requiere
  la 2.1.234 o posterior. La versión mínima exacta para channels **queda por confirmar en la
  validación en vivo**.
- [Bun](https://bun.sh) (el canal, los hooks y la CLI son scripts de Bun).
- Una cuenta de Telegram con verificación en dos pasos activada (Ajustes, Privacidad y seguridad,
  Verificación en dos pasos). Quien tome tu cuenta puede aprobar herramientas en tu PC.
- Una sesión interactiva de Claude Code. El flag de canal de desarrollo se ignora con `-p`.

Plataformas: Windows, Linux y macOS son objetivos. La CI corre las pruebas automáticas en Ubuntu y
Windows. Las dos pruebas de humo de capturas se ejecutaron en un equipo Windows; nada se ha
ejecutado a mano en Linux ni macOS (tmux, captura en Wayland y X11 y sockets Unix solo están
cubiertos por pruebas y por la lectura de la documentación).

Herramientas opcionales:

| Herramienta | Para qué | Notas |
| --- | --- | --- |
| tmux | `/stop` además envía Escape para interrumpir el turno en curso | Solo Linux y macOS, y solo si Claude Code corre dentro de un panel de tmux. Sin tmux, `/stop` bloquea la siguiente herramienta. En Windows no hay equivalente. |
| Un navegador de la familia Chromium (Chromium, Chrome, Brave, Edge) | `/shot <url>` | Se busca en el `PATH` y en las rutas de instalación habituales; o define `TELEGRAM_BRIDGE_BROWSER`. Corre sin interfaz y con un perfil desechable ([ADR 0010](docs/adr/0010-headless-browser-instead-of-playwright.md)). |
| Linux, Wayland: `grim`, `spectacle` o `gnome-screenshot` | `/shot` (pantalla) | Se prueban en ese orden. |
| Linux, X11: `maim`, `scrot` o `import` de ImageMagick | `/shot` (pantalla) | Se prueban en ese orden. |
| macOS | `/shot` (pantalla) | Usa `screencapture`, incluido en el sistema. |
| Windows | `/shot` (pantalla) | Usa el Windows PowerShell incluido; captura todos los monitores. |

En Linux el canal debe correr dentro de la sesión gráfica para capturar la pantalla. Las capturas
de páginas no necesitan pantalla.

## Instalación

Nota de idioma: las respuestas del bot y la salida de la CLI están en **español por defecto**.
Define `TELEGRAM_BRIDGE_LOCALE=en` para inglés.

**1. Crea un bot.** En Telegram abre [@BotFather](https://t.me/BotFather), envía `/newbot`, elige un
nombre y un usuario que termine en `bot`, y guarda el token que te devuelve. Trata el token como una
contraseña.

**2. Obtén el código.**

```bash
git clone https://github.com/santyxswc/Claude-Remote-Control
cd Claude-Remote-Control
bun install
```

**3. Configura el bot.** El comando pide el token sin mostrarlo (o lo lee de stdin con
`--token-stdin`), lo valida con Telegram y lo guarda en el directorio de estado con permisos solo
para tu usuario. Nunca acepta el token como argumento.

```bash
bun run bridge -- init
```

**4. Empareja tu cuenta.** La terminal muestra un QR y un enlace `t.me` que vencen en 120 segundos.
Ábrelo en el teléfono y pulsa Start. La terminal muestra entonces el nombre, el usuario y el ID
numérico de quien envió el código; escribe `s` solo si eres tú.

```bash
bun run bridge -- pair
```

**5. Inicia Claude Code con el flag del canal.** Elige una forma de ejecutarlo.

*A. Checkout de desarrollo (el `.mcp.json` del repo).* Ejecuta Claude Code en el directorio del
checkout. El servidor lo registra `.mcp.json`; solo recibe mensajes si lo nombras en el flag:

```bash
claude --dangerously-load-development-channels server:telegram-bridge
```

Claude Code muestra una advertencia a pantalla completa sobre canales de desarrollo (elige "I am
using this for local development") y, la primera vez, te pide aprobar el servidor MCP del proyecto.
Para usar el puente desde otro proyecto, agrega el servidor a tu configuración MCP de usuario con
una ruta absoluta (ver la [referencia de channels](https://code.claude.com/docs/en/channels-reference)).
En ambos casos los hooks de avisos y el freno no están activos hasta que los agregues a tus ajustes:
usa el fragmento de [docs/flows/F4.md](docs/flows/F4.md#for-people-not-using-the-plugin) con la ruta
absoluta de tu checkout. Sin los hooks no hay avisos de "terminé" y `/stop` no puede bloquear
herramientas.

*B. Como plugin.* El repositorio también es el plugin ([ADR 0009](docs/adr/0009-plugin-layout.md)):
su manifiesto declara el servidor y `hooks/hooks.json` registra los hooks. La forma documentada de
cargar un plugin desde un directorio para una sesión es:

```bash
claude --plugin-dir /ruta/a/Claude-Remote-Control
```

El flag de canal para un plugin tiene la forma `plugin:<nombre>@<marketplace>`. Cuál es el
`<marketplace>` de un plugin cargado con `--plugin-dir`, y el comando completo, **quedan por
confirmar en la validación en vivo**. El repositorio todavía no incluye un `marketplace.json`, así
que hoy no hay ruta con `/plugin install`. En el primer arranque el plugin ejecuta
`bun install --production`, que tarda varios segundos.

En ambos casos, permite la herramienta `reply` una vez; si no, cada respuesta abrirá un permiso que
a su vez se reenvía a tu teléfono. Ver [Seguridad](#seguridad) y
[docs/flows/F3.md](docs/flows/F3.md#the-reply-tool-needs-its-own-permission).

Cuando funciona, el stderr del canal (visible con `claude --debug`) registra `telegram polling
started`. Envía `/status` al bot para comprobarlo. El primer recorrido paso a paso está en
[docs/flows/README.md](docs/flows/README.md).

La CLI se ejecuta desde un checkout (`bun run bridge -- <comando>`). Usa el mismo directorio de
estado que el canal, así que sirve para ambas formas de ejecución. Ejecutar la CLI desde el
directorio de un plugin instalado **queda por confirmar en la validación en vivo**.

## Comandos del chat

Se envían al bot desde una cuenta emparejada, en chat privado. Cualquier otro texto, incluidos los
`/comandos` desconocidos, se reenvía a Claude.

| Comando | Qué hace |
| --- | --- |
| `/start` | Comprueba que el puente está conectado. |
| `/help` | Lista los comandos. |
| `/status` | Bot, emparejado desde, conexión MCP, permisos pendientes, estado del freno y tipos de captura disponibles. |
| `/stop [motivo]` | Activa el freno, deniega los permisos pendientes y, dentro de tmux en Linux o macOS, envía Escape. |
| `/resume` | Retira el freno. Claude no reanuda por sí solo. |
| `/shot` | Captura de la pantalla. |
| `/shot <url>` | Captura de una página `http`/`https`, por ejemplo `/shot localhost:3000`. |

Los permisos también aceptan `yes <id>` o `no <id>` como texto (el id aparece en la solicitud; con
`si <id>` también funciona). Las solicitudes de riesgo alto solo se aprueban con los botones.

## Comandos de la CLI

Se ejecutan como `bun run bridge -- <comando>` desde el checkout. Códigos de salida: 0 éxito, 1
fallo, 2 uso incorrecto.

| Comando | Qué hace |
| --- | --- |
| `init [--token-stdin]` | Valida y guarda el token de BotFather. |
| `pair` | Inicia el emparejamiento con QR y código de un solo uso. |
| `access list` | Lista las cuentas de Telegram permitidas. |
| `access revoke <id>` | Retira el acceso a una cuenta. |
| `stop [motivo]` | Activa el freno desde la terminal. |
| `resume` | Retira el freno. |
| `--help` | Muestra el uso. |

## Configuración

Todo son variables de entorno opcionales.

| Variable | Valor por defecto | Significado |
| --- | --- | --- |
| `TELEGRAM_BRIDGE_HOME` | `<CLAUDE_CONFIG_DIR o ~/.claude>/channels/telegram-bridge` | Directorio de estado (token, base de datos, banderas). Usa uno desechable en las primeras pruebas. Debe ser absoluta o empezar con `~/`. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Base del directorio de estado por defecto. Debe ser absoluta o empezar con `~/`, igual que `TELEGRAM_BRIDGE_HOME`: un valor relativo se rechaza (la CLI falla, el canal sirve MCP sin Telegram, el hook del freno usa el directorio por defecto); nunca se resuelve contra el directorio actual. |
| `TELEGRAM_BOT_TOKEN` | sin definir | Reemplaza el token guardado por `init`. Se recomienda el archivo. |
| `TELEGRAM_BRIDGE_LOCALE` | `es` | `en` para inglés. |
| `TELEGRAM_BRIDGE_BROWSER` | autodetectado | Ruta absoluta del navegador para `/shot <url>`. Un valor inválido desactiva las capturas de páginas. |
| `TELEGRAM_BRIDGE_DEBUG` | sin definir | `1` imprime diagnósticos en stderr desde los scripts de hooks. |
| `TELEGRAM_BRIDGE_DEV_PORT` | sin definir | Solo desarrollo, sin bot: un listener HTTP local (F0) que exige el token bearer que imprime una vez en stderr, rechaza peticiones de navegador (`Origin`, `Host` ajeno) y no arranca si hay un token de bot configurado. Déjala sin definir. |

Los hooks, la CLI y el canal deben resolver el mismo directorio de estado; define estas variables
igual para todos (heredan el entorno de Claude Code).

## Seguridad

Lee esto antes de usarlo.

- **Quien controla el bot o tu cuenta de Telegram controla tu PC.** Puede enviar prompts a Claude y
  aprobar herramientas. Activa la verificación en dos pasos de Telegram y guarda en secreto el token
  del bot. Si se filtra, revócalo en BotFather.
- **Los chats con bots no tienen cifrado de extremo a extremo.** Telegram puede leer todo lo que
  envía el puente, incluidos código, rutas y salidas de comandos.
- **La censura es de mejor esfuerzo.** Detecta formas conocidas de credenciales y los valores de los
  `.env` del proyecto, no todos los secretos. El texto que tú envías a Claude no se censa.
- **Las capturas de pantalla se saltan la censura.** Lo que haya en pantalla o en la página llega a
  Telegram como píxeles. Cada imagen lo advierte en su leyenda.
- **Nunca uses `--dangerously-skip-permissions` con esto.** El relay de permisos existe para no
  necesitarlo.
- **El flag de canal de desarrollo.** Un canal propio no está en la lista aprobada por Anthropic, así
  que solo corre con `--dangerously-load-development-channels`, que se salta esa lista tras una
  confirmación. Carga solo código en el que confíes; por eso el flag dice "dangerously".
- **Permite la herramienta reply y nada más amplio.** Agrega `mcp__telegram-bridge__reply` a las
  reglas de permitidos de los ajustes de Claude Code (como plugin el nombre tiene la forma
  `mcp__plugin_<plugin>_<servidor>__reply`; compruébalo con `/permissions`). No permitas de antemano
  `send_screenshot`: cada captura debe seguir siendo una decisión. Detalles:
  [docs/flows/F3.md](docs/flows/F3.md#the-reply-tool-needs-its-own-permission).
- Los desconocidos no reciben respuesta ni generan eventos. Solo se aceptan chats privados de IDs de
  usuario permitidos.

Modelo completo y límites conocidos: [docs/threat-model.md](docs/threat-model.md) y
[SECURITY.md](SECURITY.md) (en inglés).

## Solución de problemas

- **409 Conflict, o "otro proceso está consultando".** Telegram atiende a un solo consumidor por bot.
  Cierra otras sesiones de Claude Code que usen el puente, otros programas con el mismo token (otra
  máquina, otro plugin de Telegram) y procesos `bun` huérfanos. El puente nunca mata otros procesos;
  un titular caído libera el bloqueo en menos de 60 segundos
  ([ADR 0006](docs/adr/0006-single-poller-lock.md)).
- **"No configurado".** El canal registra que Telegram no está configurado, y la CLI pide ejecutar
  `init` primero. Ejecuta `bun run bridge -- init` y luego `pair`, con el mismo `TELEGRAM_BRIDGE_HOME`
  que el canal.
- **Los mensajes no llegan a Claude.** Claude Code descarta en silencio los eventos de un canal si el
  servidor no está nombrado en el flag. Revisa el flag y `/mcp`. Comprueba también que tu cuenta esté
  emparejada (`access list`).
- **El freno está activo.** `/status` lo muestra y los mensajes del chat no se reenvían. Envía
  `/resume`, ejecuta `bun run bridge -- resume` o borra `brake.json` del directorio de estado. Un
  `brake.json` corrupto también bloquea.
- **Los hooks no se disparan (no llega "terminé", o los botones siguen tras responder en la
  terminal).** Los hooks deben estar cargados (el plugin o el fragmento de ajustes) y resolver el
  mismo directorio de estado. Solo el proceso que consulta Telegram los escucha, y el canal registra
  `listening for hook events`. Ejecuta Claude Code con `TELEGRAM_BRIDGE_DEBUG=1` para ver por qué un
  hook se rindió. `bun` debe estar en el `PATH`.
- **`/shot` no tiene herramienta de captura.** La respuesta indica qué instalar (ver la tabla de
  herramientas opcionales). `/status` muestra qué tipos están disponibles. En Linux el canal debe
  correr dentro de la sesión de escritorio; tras instalar una herramienta, reinicia la sesión.

## Cómo funciona

Claude Code arranca el canal (`src/main.ts`) como servidor MCP por stdio. El canal consulta Telegram
por long polling, pasa cada mensaje por una cadena de controles (chat privado, emparejamiento, lista
de permitidos, límite de tasa, solo texto, veredictos de permisos, comandos, freno) y reenvía lo que
sobrevive a la sesión como notificación del canal. Todo lo que vuelve pasa por censura y troceo. Los
hooks corren como procesos cortos dentro de Claude Code y hablan con el canal por un socket Unix
local o una tubería con nombre; el hook del freno lee un archivo bandera. El estado vive en SQLite y
en unos pocos archivos del directorio de estado. Ver [docs/architecture.md](docs/architecture.md).

## Desarrollo

```bash
bun install
bun run check   # lint, tipos, reglas de arquitectura y pruebas (lo que corre la CI)
```

Estructura: `src/domain` (reglas puras), `src/application` (puertos y casos de uso), `src/adapters`
(Telegram, MCP, SQLite, capturas, IPC, sesión), `src/composition` y los cuatro puntos de entrada
(`main.ts`, `cli.ts`, `hook.ts`, `brakeHook.ts`), `hooks/`, `skills/`, `tests/`, `docs/`. Ver
[CONTRIBUTING.md](CONTRIBUTING.md) y [CLAUDE.md](CLAUDE.md).

## Documentación

La documentación técnica está en inglés, salvo el diseño original.

- [docs/architecture.md](docs/architecture.md): capas, puertos, procesos, patrones, archivos de estado
- [docs/flows/README.md](docs/flows/README.md): índice de flujos y lista de validación en vivo
- [docs/threat-model.md](docs/threat-model.md) y [SECURITY.md](SECURITY.md)
- [docs/adr/](docs/adr/): decisiones y hallazgos sobre el contrato de Claude Code
- [docs/roadmap.md](docs/roadmap.md): fases y decisiones abiertas
- [docs/plan.md](docs/plan.md): el diseño original (en español)
