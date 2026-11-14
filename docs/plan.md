# Puente Telegram ↔ Claude Code — Planeación por flujos

Nov 12, 2026 · @santiago

## Visión y alcance

El proyecto es un channel propio de Claude Code que convierte un chat de Telegram en el control remoto de una sesión que corre en el PC del usuario. Resuelve un problema concreto: Claude termina una tarea o pide un permiso, y la sesión queda detenida hasta que alguien vuelve al teclado.

Primero es un proyecto personal. Desde el diseño queda listo para que otra persona lo instale en su propio PC sin depender de la infraestructura de nadie.

El MVP incluye seis capacidades:

- Mensajes en ambos sentidos entre Telegram y la sesión.
- Solicitudes de permiso con botones Aprobar / Denegar.
- Avisos deterministas de "terminé" y "necesito respuesta" mediante hooks.
- Capturas de pantalla a demanda.
- Botón de pánico `/stop`.
- Emparejamiento seguro entre la cuenta de Telegram y el PC.

Quedan para fases posteriores: git desde el chat, mensaje fijado de estado, entrada de imágenes y archivos, resumen de sesión a memoria, notas de voz, un topic por proyecto y la Mini App con pantalla en vivo.

Queda fuera de alcance contestar llamadas de Telegram: la Bot API no lo permite y un userbot pone en riesgo la cuenta personal.

## Decisión de distribución

Recomendación: cada usuario crea su propio bot y todo corre en su PC, sin bot compartido ni servidor central. Así nadie, tampoco el autor del proyecto, puede leer ni controlar la sesión de otra persona.

| Criterio | Bot propio por usuario (recomendado) | Bot compartido con relay |
| --- | --- | --- |
| Infraestructura | Ninguna: el plugin consulta a Telegram desde el PC | Un servidor tuyo encendido 24/7 |
| Quién ve los mensajes | El usuario y Telegram | El usuario, Telegram y tu servidor |
| Si comprometen el punto central | No existe punto central | El atacante envía prompts y aprueba permisos en el PC de todos |
| Alta de un usuario | Unos 3 minutos: BotFather más asistente `init` | Alrededor de 1 minuto: abrir el bot y emparejar |
| Costo y responsabilidad | Cero | Hosting, disponibilidad y custodia de datos ajenos |

Los chats con bots no tienen cifrado de extremo a extremo. Un relay no puede ser "ciego": quien opera el bot compartido lee código, rutas y salidas de todos.

El código único por persona se mantiene: es el emparejamiento entre la cuenta de Telegram y el PC, descrito en Seguridad. Lo genera el programa local con un generador criptográfico, no el modelo. Un LLM no es fuente segura de aleatoriedad y el código quedaría en su contexto.

El paso de BotFather se suaviza con un asistente `init` que guía, valida el token y deja todo configurado. El bot compartido queda como fase opcional: la arquitectura lo admite como un adaptador más, con su propio análisis de amenazas.

## Stack tecnológico

TypeScript sobre Bun es la elección por mérito: el contrato de channels exige el SDK `@modelcontextprotocol/sdk` y un runtime compatible con Node, según la [referencia de channels](https://code.claude.com/docs/en/channels-reference). Los plugins oficiales también corren en Bun, así que el camino de instalación ya está probado.

| Capa | Elección | Por qué | Alternativa |
| --- | --- | --- | --- |
| Lenguaje y runtime | TypeScript + Bun | Lo pide el contrato; tipado estricto; arranque rápido | Node 22 LTS |
| Enlace con Claude Code | SDK MCP oficial por stdio | Único requisito duro del contrato | Ninguna |
| Telegram | grammY | TypeScript nativo; teclados inline y Mini Apps; corre en Bun, Node y Deno | Telegraf |
| Validación | Zod | Un esquema valida notificaciones MCP, callbacks y configuración; la referencia oficial ya lo usa | Valibot |
| Estado local | SQLite (`bun:sqlite`, modo WAL) | Un archivo, transaccional, sin servicio aparte | Archivos JSON |
| Hooks ↔ canal | Socket Unix con permisos 0600 | No abre puertos de red | HTTP en 127.0.0.1 con token |
| Capturas | Playwright para apps web; captura nativa para escritorio | Capturas reproducibles sin depender del entorno gráfico | Solo captura nativa |
| Pruebas | `bun test` con dobles de los puertos | Prueba los casos de uso sin Telegram ni Claude Code | Vitest |
| Calidad y CI | Biome, GitHub Actions, Conventional Commits | Lint y formato en una sola herramienta; historial legible | ESLint + Prettier |

PostgreSQL no se justifica aquí: es una aplicación local de un solo usuario y SQLite cubre emparejamientos, solicitudes pendientes y auditoría.

Para fases posteriores: whisper.cpp para voz a texto local, Vega-Lite con resvg para gráficas PNG sin navegador, y WebSocket con túnel HTTPS para la Mini App.

## Arquitectura

Arquitectura limpia con puertos y adaptadores: el núcleo decide qué hacer con cada mensaje o permiso, sin conocer a Telegram ni a Claude Code. Cambiar de plataforma de chat o sumar un daemon es agregar un adaptador.

&#91;embedded content: componentes · un proceso local entre Telegram y Claude Code\]

Todo lo que entra o sale pasa por el núcleo. Telegram solo recibe conexiones salientes desde el PC, y los hooks hablan con el canal por un socket local.

### Capas

| Capa | Contiene | Depende de |
| --- | --- | --- |
| Dominio | `Pairing`, `AllowedSender`, `PermissionRequest`, `RiskLevel`; políticas de censura y de riesgo | Nada |
| Aplicación | Casos de uso `PairDevice`, `HandleInboundMessage`, `RelayPermissionRequest`, `ResolvePermission`, `NotifySessionEvent`, `CaptureScreenshot`, `StopSession`; y los puertos | Dominio |
| Adaptadores | `TelegramGateway`, `McpChannelServer`, almacenes SQLite, capturadores, `HookIpcServer`, `TmuxSessionController` | Aplicación |
| Composición | `main.ts`: arma las dependencias a mano, sin contenedor | Todas |

Los puertos que define la capa de aplicación son `ChatGateway`, `ChannelPort`, `PairingStore`, `PermissionStore`, `AuditLog`, `ScreenCapturer`, `SessionController`, `Clock` y `RandomSource`.

### Patrones GoF

| Patrón | Dónde | Qué resuelve |
| --- | --- | --- |
| Adapter | `TelegramGateway`, `McpChannelServer` | Aísla grammY y el SDK MCP detrás de puertos |
| Chain of Responsibility | Tubería de entrada: autenticación, límite de tasa, veredicto de permiso, comando, reenvío a Claude | Nada avanza sin autenticarse; cada control se prueba solo |
| Decorator | Tubería de salida sobre `ChatGateway`: censura de secretos y troceo de mensajes largos | Ningún mensaje sale sin pasar por la censura |
| Command | Cada comando (`/stop`, `/shot`, `/status`) y cada botón es un objeto registrado | Agregar un comando no toca el enrutador |
| Strategy | `ScreenCapturer` por plataforma; `RiskPolicy` | Cambia el algoritmo sin tocar el caso de uso |
| State | Ciclo de `PermissionRequest`: pendiente, aprobada, denegada, resuelta en terminal, expirada | Impide transiciones inválidas, como aprobar dos veces |
| Observer | Eventos de dominio hacia auditoría y mensaje de estado | La auditoría no se acopla a los casos de uso |
| Factory Method | Elección del capturador según sistema operativo y servidor gráfico | El caso de uso no pregunta en qué plataforma corre |

### SOLID

- **S:** un caso de uso por archivo, con una sola razón de cambio.
- **O:** comandos, capturadores y eslabones de la tubería se agregan sin modificar los existentes.
- **L:** cualquier `ChatGateway`, real o doble de prueba, es intercambiable.
- **I:** puertos pequeños; el caso de uso de capturas no ve el almacén de emparejamientos.
- **D:** la aplicación define los puertos y los adaptadores dependen de ella.

### Restricción que condiciona el diseño

Claude Code lanza el canal como subproceso por stdio, y Telegram entrega las actualizaciones de un bot a un solo consumidor a la vez. Por eso el MVP es un bot para una sesión. El soporte multi-proyecto extrae un daemon dueño del bot que enruta hacia el canal de cada sesión; gracias a los puertos, solo cambia un adaptador.

## Seguridad

Quien controla el bot controla el PC, así que la seguridad es requisito del MVP y no una fase. El diseño asume que el chat con el bot no es secreto: los mensajes viajan cifrados hasta Telegram, pero Telegram puede leerlos.

### Emparejamiento con código único

1. El usuario ejecuta `pair` en la terminal. El programa genera 128 bits con el generador criptográfico del sistema.
2. La terminal muestra un QR con el enlace `t.me/<bot>?start=<código>`. El código vale 120 segundos y un solo uso.
3. El usuario escanea el QR. Telegram abre el bot y envía el código.
4. El canal compara el código en tiempo constante y muestra en la terminal el nombre de usuario y el ID numérico de quien lo envió.
5. El usuario confirma en la terminal. Solo entonces ese ID entra en la lista de permitidos.

Interceptar el código no alcanza: el atacante tendría que usarlo antes de 120 segundos y, además, lograr que alguien frente a la terminal confirme su identidad. Adivinar 128 bits no es viable, y cinco intentos fallidos cancelan el emparejamiento. Después del emparejamiento el código ya no sirve; en disco solo queda el ID permitido.

### Amenazas y controles

| Amenaza | Control |
| --- | --- |
| Un extraño le escribe al bot | Lista de permitidos por ID del remitente (`from.id`), nunca por ID del chat. Todo lo demás se descarta en silencio. Solo chats privados en el MVP |
| Se filtra el token del bot | Token en archivo 0600 fuera del repo y fuera de los logs. Con él se puede suplantar al bot, pero no fabricar mensajes con tu ID. Se revoca en BotFather |
| Secuestran tu cuenta de Telegram | Verificación en dos pasos de Telegram exigida en la guía; TOTP opcional para acciones de riesgo alto; bloqueo tras inactividad |
| Un secreto sale por el chat | Censura en la tubería de salida: tokens con prefijo conocido, valores de `.env`, claves privadas |
| Aprobación por error de algo destructivo | `RiskPolicy` detecta patrones como `rm -rf`, `git push --force` o `DROP` y exige un segundo toque |
| Botón viejo o pulsado dos veces | Cada botón lleva el `request_id` que emite Claude Code; el estado impide resolver dos veces; el teclado se retira al resolver |
| Texto engañoso en la vista previa de un permiso | `description` e `input_preview` se muestran como texto plano escapado, sin formato ni enlaces |
| Otro proceso local escribe al socket de hooks | Socket 0600 dentro del directorio del usuario |
| No queda rastro de lo aprobado | Auditoría de solo anexar: quién, cuándo, qué herramienta y qué veredicto |

Claude Code ya enmascara credenciales reconocibles en las solicitudes de permiso desde la versión 2.1.234, pero no las que carecen de prefijo conocido, según la [referencia de channels](https://code.claude.com/docs/en/channels-reference). La censura propia sigue siendo necesaria.

### Límites que conviene declarar

- El chat no tiene cifrado de extremo a extremo. Para proyectos confidenciales habrá un modo `privacy: minimal` que envía solo avisos, sin código ni rutas.
- El proyecto no usa ni recomienda `--dangerously-skip-permissions`. El relay de permisos lo hace innecesario.

## Flujos del MVP

El MVP son siete flujos en orden de construcción. Cada uno es una unidad de trabajo para entregar a Claude Code, con su criterio de aceptación.

### F0 · Esqueleto y prueba técnica

**Objetivo:** comprobar el contrato de channels antes de escribir lógica.

1. Crear el repo con Bun, TypeScript estricto, Biome y CI.
2. Escribir un canal mínimo que declare `claude/channel`, exponga `reply` y emita una notificación de prueba.
3. Arrancar con `claude --dangerously-load-development-channels server:<nombre>`.
4. Resolver tres incógnitas: si hay un proceso de canal por sesión, cómo llega `permission_request` y cómo se interrumpe un turno.

**Listo cuando:** un `curl` local llega a Claude y la respuesta de Claude vuelve al proceso.

### F1 · Instalación y emparejamiento

**Objetivo:** dejar el bot configurado y una sola cuenta autorizada.

1. `init` pide el token de BotFather, lo valida con `getMe` y lo guarda con permisos 0600.
2. `pair` ejecuta el emparejamiento descrito en Seguridad.
3. `access list` y `access revoke` administran la lista de permitidos.

**Listo cuando:** una segunda cuenta de Telegram le escribe al bot y no ocurre nada: ni respuesta ni evento en la sesión.

### F2 · Mensajería en ambos sentidos

**Objetivo:** dar instrucciones y recibir respuestas desde el chat.

1. El mensaje llega por long polling y recorre la tubería de entrada.
2. El canal emite `notifications/claude/channel` con el `chat_id` en `meta`.
3. Claude responde con la herramienta `reply`.
4. La tubería de salida censura secretos y trocea en bloques de 4096 caracteres.
5. Si Claude está ocupado, el evento queda en cola y el bot responde "en cola".

**Listo cuando:** una instrucción enviada desde el teléfono produce un cambio en el repo y un resumen en el chat.

### F3 · Permisos con botones

**Objetivo:** aprobar o denegar herramientas sin volver al teclado.

1. El canal declara `claude/channel/permission`.
2. Al llegar `permission_request`, crea una `PermissionRequest` pendiente.
3. Envía herramienta, descripción, vista previa, nivel de riesgo y los botones Aprobar / Denegar.
4. Al pulsar, verifica remitente y estado, y emite el veredicto `allow` o `deny` con el `request_id`.
5. Si el riesgo es alto, pide un segundo toque antes de emitir.
6. Si alguien responde antes en la terminal, un hook `PostToolUse` o el vencimiento retiran los botones.

**Listo cuando:** Claude pide ejecutar un comando, se aprueba desde el teléfono y el diálogo local se cierra solo.

Los diálogos de confianza del proyecto y de consentimiento de servidores MCP no se retransmiten. Hay que aceptarlos en la terminal antes de salir.

### F4 · Avisos por hooks

**Objetivo:** enterarse de "terminé" y "necesito respuesta" sin depender de que Claude escriba.

1. El plugin registra los hooks `Stop` y `Notification`, que ejecutan `bridge hook <evento>`.
2. Ese comando reenvía el JSON del hook al socket Unix del canal.
3. `NotifySessionEvent` arma el aviso con el último mensaje de Claude, tomado de la transcripción.
4. Un antirrebote evita avisos repetidos o inmediatamente posteriores a un mensaje tuyo.

**Listo cuando:** una tarea iniciada desde la terminal avisa al teléfono al terminar, sin que Claude llame a ninguna herramienta.

### F5 · Capturas a demanda

**Objetivo:** ver cómo va la aplicación en desarrollo.

1. `/shot` captura la pantalla y `/shot <url>` captura una página con Playwright.
2. La herramienta MCP `send_screenshot` deja que Claude envíe capturas por iniciativa propia.
3. El bot advierte que las imágenes no pasan por la censura de secretos.

**Listo cuando:** `/shot http://localhost:3000` devuelve la imagen en el chat.

### F6 · Botón de pánico

**Objetivo:** frenar a Claude al instante.

1. `/stop` activa una bandera de freno en disco.
2. Un hook `PreToolUse` consulta la bandera y bloquea toda herramienta mientras esté activa.
3. El canal deniega las solicitudes pendientes y pide a `SessionController` interrumpir el turno con Escape vía `tmux send-keys`.
4. `/resume` retira la bandera.

**Listo cuando:** con una tarea larga en curso, `/stop` impide cualquier herramienta nueva.

El freno es un hook porque los eventos del canal quedan en cola mientras Claude trabaja. Un mensaje "detente" no interrumpe nada por sí solo.

## Flujos de fases posteriores

Nueve flujos amplían el MVP sin tocar el núcleo: cada uno agrega comandos, herramientas MCP o un adaptador.

| Flujo | Qué hace | Clave de diseño |
| --- | --- | --- |
| F7 · Opciones y skills | `/skills` lista las skills del proyecto como botones. La herramienta `ask_choice` deja que Claude ofrezca opciones con botones | Elegir un botón envía una instrucción normal; no salta permisos |
| F8 · Git desde el chat | `/diff` envía el diff como archivo, con botones Commit, Revertir y Abrir PR | Cada botón es una instrucción predefinida que pasa por el relay de permisos |
| F9 · Mensaje fijado de estado | Un mensaje fijado muestra la tarea actual y los pendientes, editado en vivo | Lo alimentan los hooks, no Claude |
| F10 · Imágenes y archivos entrantes | Una foto o archivo se guarda en una carpeta temporal y llega a Claude como ruta | Límite de tamaño y lista de tipos permitidos |
| F11 · Gráficas | La herramienta `send_chart` recibe una especificación Vega-Lite y envía el PNG | Sin navegador: Vega a SVG y resvg a PNG |
| F12 · Resumen y memoria | Al cerrar la sesión o con `/wrap`, Claude resume y guarda en `docs/sessions/`. Propone líneas para `CLAUDE.md` | Nada entra a `CLAUDE.md` sin tu aprobación por botón |
| F13 · Notas de voz | whisper.cpp transcribe en local; el bot muestra el texto y pide confirmar | Confirmar evita que un error de transcripción se vuelva un comando |
| F14 · Multi-proyecto | Un daemon es dueño del bot. Un grupo con topics tiene un topic por sesión | Se enruta por topic, pero se autentica siempre por remitente |
| F15 · Mini App con pantalla en vivo | Un botón abre la Mini App con el stream de la app en desarrollo | Valida `initData` con HMAC, solo lectura, y requiere un túnel HTTPS opcional |

F12 pide aprobación porque lo que entra a `CLAUDE.md` condiciona todas las sesiones futuras. F15 es el único flujo que expone el PC hacia internet, por eso es opcional y va al final.

## Repositorio y documentación

Un solo repo empaquetado como plugin de Claude Code: quien lo clone instala, ejecuta `init` y `pair`, y queda funcionando en su PC.

```
telegram-bridge/
├── .claude-plugin/      manifiesto del plugin
├── hooks/               Stop, Notification, PreToolUse, PostToolUse
├── skills/              /bridge:init, /bridge:pair, /bridge:access
├── src/
│   ├── domain/          entidades y políticas, sin dependencias
│   ├── application/
│   │   ├── ports/
│   │   └── use-cases/
│   ├── adapters/
│   │   ├── telegram/
│   │   ├── mcp/
│   │   ├── storage/
│   │   ├── capture/
│   │   ├── ipc/
│   │   └── session/
│   └── main.ts          composición
├── miniapp/             fase 4
├── tests/
├── docs/
│   ├── adr/
│   ├── flows/
│   ├── architecture.md
│   └── threat-model.md
├── CLAUDE.md
├── SECURITY.md
├── CONTRIBUTING.md
└── README.md
```

| Documento | Contenido |
| --- | --- |
| `README.md` | En inglés, con versión en español: qué es, instalación en 5 pasos, demo y advertencia de seguridad |
| `docs/flows/` | Un archivo por flujo: objetivo, pasos, criterio de aceptación y diagrama Mermaid. Es lo que se entrega a Claude Code |
| `docs/adr/` | Una decisión por archivo. Las primeras: bot propio frente a relay, TypeScript con Bun, freno por hook, SQLite |
| `docs/threat-model.md` | La tabla de amenazas de este plan, mantenida al día |
| `SECURITY.md` | Cómo reportar una vulnerabilidad y qué versiones tienen soporte |
| `CLAUDE.md` | Reglas de arquitectura para Claude Code: dependencias hacia adentro, un caso de uso por archivo, pruebas antes de cerrar un flujo |

Una regla de CI verifica que `domain/` y `application/` no importen nada de `adapters/`. Así la arquitectura no depende de la disciplina.

## Roadmap por fases

Seis fases, cada una con una condición de salida verificable. La publicación va justo después del MVP para que el repo empiece a tener uso real pronto.

| Fase | Flujos | Entregable | Se pasa de fase cuando |
| --- | --- | --- | --- |
| 0 · Prueba técnica | F0 | Canal mínimo funcionando | Las tres incógnitas quedan respondidas en un ADR |
| 1 · MVP | F1 a F6 | Control remoto usable a diario | Pasas una jornada fuera de casa sin volver al teclado, con las pruebas en verde |
| 2 · Publicación | Ninguno nuevo | Repo público con README, demo y `SECURITY.md` | Otra persona lo instala en su PC siguiendo solo el README |
| 3 · Productividad | F7 a F12 | Botones de opciones, git, estado, archivos, gráficas y memoria | Una sesión completa se cierra con resumen guardado y aprobado |
| 4 · Voz y multi-proyecto | F13 y F14 | Daemon y un topic por sesión | Dos sesiones simultáneas trabajan sin cruce de mensajes |
| 5 · Mini App | F15 | Pantalla en vivo dentro de Telegram | El túnel pasa una revisión de seguridad escrita |

El bot compartido con relay no está en el roadmap. Si se retoma, empieza por un análisis de amenazas propio antes de escribir código.

## Riesgos y puntos a verificar

El mayor riesgo es de plataforma: channels está en research preview y un canal propio no entra en la lista aprobada por Anthropic.

| Riesgo | Efecto | Respuesta |
| --- | --- | --- |
| Channels es research preview | El flag y el protocolo pueden cambiar | Todo el contrato vive en un adaptador; el README fija la versión mínima de Claude Code |
| El canal propio no está en la lista aprobada | Cada usuario arranca con `--dangerously-load-development-channels` y acepta un aviso. El flag se ignora en modo `-p` | Documentarlo sin rodeos; solo sesiones interactivas |
| Planes Team y Enterprise | Un administrador debe habilitar channels | Indicarlo como requisito |
| El canal no se entera si un permiso se responde en la terminal | Botones huérfanos en el chat | Hook `PostToolUse` y vencimiento, como en F3 |
| Interrumpir un turno depende de tmux | Sin tmux, `/stop` solo frena herramientas nuevas | El freno por hook es la garantía; tmux es la mejora |
| El PC se suspende | La sesión deja de recibir eventos | Guía de tmux e inhibición de suspensión |

### A verificar en F0

- [ ] Que Claude Code lanza un proceso de canal por sesión.
- [ ] Nombres y datos de entrada de los hooks `Stop`, `Notification`, `PreToolUse` y `PostToolUse`.
- [ ] Estructura exacta del manifiesto de plugin, con hooks y skills incluidos.
- [ ] Un método fiable para interrumpir un turno en curso.
- [ ] Límites vigentes de la Bot API para `callback_data` y tamaño de archivos.

### Decisiones abiertas

- [ ] Nombre del proyecto y del repo.
- [x] Licencia: MIT.
- [ ] Wayland o X11 en tu Arch, para elegir el capturador nativo.

## Fuentes

- [Channels](https://code.claude.com/docs/en/channels): requisitos, seguridad y estado de research preview.
- [Channels reference](https://code.claude.com/docs/en/channels-reference): contrato del canal, herramienta `reply`, filtrado de remitentes y relay de permisos.
- [Plugin oficial de Telegram](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram): implementación de referencia del emparejamiento.
- [Telegram APIs](https://core.telegram.org/api.md): las llamadas pertenecen a la API MTProto, no a la Bot API.
