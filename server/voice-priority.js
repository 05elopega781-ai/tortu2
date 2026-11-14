export default {
  trackMeters: 100,
  levels: [
    { id: 'move', priority: 0, ttlMs: 20000, max: 8, interrupt: true, say: 'Cambio de equipo', coalesceMs: 0, everyMs: 0, quietMs: 0, maxChars: 140 },
    { id: 'gift', priority: 1, ttlMs: 15000, max: 5, interrupt: true, say: 'Gracias por el regalo', coalesceMs: 0, everyMs: 0, quietMs: 0, maxChars: 140 },
    { id: 'chat', priority: 2, ttlMs: 20000, max: 3, say: 'Comentario', coalesceMs: 0, everyMs: 0, quietMs: 0, maxChars: 140 },
    { id: 'welcome', priority: 2, ttlMs: 25000, max: 6, say: 'Bienvenido', coalesceMs: 0, everyMs: 0, quietMs: 0, maxChars: 140 },
    { id: 'action', priority: 3, ttlMs: 12000, max: 3, say: 'Acción', coalesceMs: 8000, everyMs: 0, quietMs: 0, maxChars: 140 },
    { id: 'match', priority: 4, ttlMs: 14000, max: 1, say: 'Estado del partido', coalesceMs: 14000, everyMs: 14000, quietMs: 14000, maxChars: 140 }
  ]
};
