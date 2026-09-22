# Pizarra en Vivo

Una pizarra colaborativa ligera, inspirada en la aplicación publicada. Permite dibujar desde una pantalla y proyectar el resultado en otra pestaña o dispositivo que comparta el mismo origen.

## Uso

1. Elige **Escribir** para crear una sala y dibujar.
2. En la pantalla de proyección, elige **Proyectar** e ingresa el código de sala.
3. Las actualizaciones viajan mediante `BroadcastChannel`; por ello funciona entre pestañas del mismo navegador/origen.

## Desarrollo

Requiere Node.js 20 o posterior.

```bash
npm install
npm run start
```

## Despliegue

El proyecto es un sitio estático Vite.

```bash
npm install
npm run build
```

Publica el contenido de `dist/` en GitHub Pages, Netlify, Cloudflare Pages o cualquier hosting estático. Para colaboración entre dispositivos reales, sustituye `BroadcastChannel` por un servicio de sincronización (por ejemplo WebSocket, Supabase Realtime o Firebase) manteniendo el campo `room` como identificador de sesión.

## Nota

Esta es una reconstrucción independiente basada en la experiencia observable del sitio. No modifica ni depende del sitio original.
