import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ============================================================================
// POPUTKI.ONLINE — AI Travel Assistant Edge Function (Secured Hotfix v10)
// Server-to-Server authenticated endpoint for Telegram Bot fallback.
// ============================================================================

interface RequestPayload {
  telegram_id: number;
  chat_id: number;
  message: string;
  request_id: string;
}

interface SearchTripParams {
  from_city?: string;
  to_city?: string;
  date?: string;
  trip_type?: 'all' | 'rides' | 'bus_tickets';
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function getDushanbeDateTime(): { currentDate: string; currentTime: string } {
  // Asia/Dushanbe is UTC+5 (standard time without DST)
  const dushanbeOffsetMs = 5 * 60 * 60 * 1000;
  const now = new Date(Date.now() + dushanbeOffsetMs);
  const iso = now.toISOString();
  return {
    currentDate: iso.split('T')[0],
    currentTime: iso.split('T')[1].substring(0, 8)
  };
}

// City synonym dictionary for robust Central Asian search
const CITY_NORMALIZATION: Record<string, string> = {
  'худжанд': 'Худжанд',
  'хуҷанд': 'Худжанд',
  'khujand': 'Худжанд',
  'ходжент': 'Худжанд',
  'душанбе': 'Душанбе',
  'dushanbe': 'Душанбе',
  'бохтар': 'Бохтар',
  'bokhtar': 'Бохтар',
  'курган-тюбе': 'Бохтар',
  'куляб': 'Куляб',
  'кӯлоб': 'Куляб',
  'kulob': 'Куляб',
  'пенджикент': 'Пенджикент',
  'панҷакент': 'Пенджикент',
  'исфара': 'Исфара',
  'канибадам': 'Канибадам',
  'конибодом': 'Канибадам',
  'истаравшан': 'Истаравшан',
  'уструшана': 'Истаравшан',
  'турсунзаде': 'Турсунзаде',
  'хорог': 'Хорог',
  'хоруғ': 'Хорог',
  'москва': 'Москва',
  'moscow': 'Москва',
  'тюмень': 'Тюмень',
  'сургут': 'Сургут',
  'нижневартовск': 'Нижневартовск',
  'ташкент': 'Ташкент',
  'tashkent': 'Ташкент'
};

function normalizeCity(city: string | undefined): string | undefined {
  if (!city) return undefined;
  const clean = city.trim().toLowerCase();
  return CITY_NORMALIZATION[clean] || city.trim();
}

const SYSTEM_PROMPT = `Ты — официальный AI-ассистент POPUTKI.ONLINE (информационный агрегатор поездок и автобусных билетов).
Помогаешь пассажирам планировать поездки по Таджикистану и междугородние автобусные рейсы в Россию.

АБСОЛЮТНЫЕ ПРАВИЛА И ЗАПРЕТЫ:
1. НИКОГДА не выдумывай рейсы, ID, перевозчиков, даты, цены, места и контакты. Рейсы существуют ТОЛЬКО если они возвращены инструментом search_trips.
2. Если по запросу ничего не найдено, честно ответь: «К сожалению, на указанную дату рейсов не найдено» и предложи проверить ближайшие дни или открыть поиск в приложении.
3. НИКОГДА не показывай личные номера телефонов водителей или перевозчиков в чате. Сообщи: «Контакты диспетчера и водителя будут доступны в электронном билете после оформления».
4. ПРАВИЛА ОПЛАТЫ (строго по регламенту сервиса):
   - При покупке автобусного билета 10% (сервисный сбор) оплачивается онлайн картой (Корти Милли / Uzcard / Visa).
   - Оставшиеся 90% стоимости оплачиваются водителю/перевозчику наличными при посадке.
   - Никогда не говори, что билет полностью бесплатный или оплачивается на 100% онлайн.
5. ДОКУМЕНТЫ И ГРАНИЦА:
   - Сервис не предоставляет юридических консультаций.
   - Для поездки в РФ гражданам РТ необходим действующий загранпаспорт и отсутствие запретов на въезд. Напомни пассажиру проверить запреты в официальных органах МВД.
6. БАГАЖ И ВРЕМЯ:
   - В автобусный билет обычно входит 1 место багажа (до 25-30 кг). За крупный багаж и посылки условия согласовываются с диспетчером рейса.
   - Время в пути является ориентировочным, так как зависит от времени прохождения пограничных пунктов.
7. ЯЗЫК ОТВЕТА:
   - Определяй язык ответа (русский, таджикский или узбекский) СТРОГО по ПОСЛЕДНЕМУ входящему сообщению пользователя.
   - Игнорируй язык предыдущих сообщений в истории чата: если последнее сообщение на русском — отвечай строго на русском, если на таджикском — на таджикском, если на узбекском — на узбекском.
8. ФОРМАТ ВЫВОДА РЕЙСОВ:
   - Когда инструмент search_trips вернул рейсы, сформируй ТОЛЬКО ОДНО короткое вводное предложение (например: «Вот найденные варианты по вашему запросу:»).
   - НЕ создавай Markdown-заголовки (###), НЕ дублируй карточки поездок вручную, НЕ используй жирные маркеры (**), так как структурированные карточки и кнопки бронирования выводятся клиентом автоматически из данных инструмента.
   - НИКОГДА не переопределяй и не изменяй значения полей, возвращенных инструментом.
9. СТИЛЬ:
   - Отвечай вежливо, кратко.
   - Не упоминай названия внутренних инструментов и технические детали.`;

async function searchTrips(
  supabase: ReturnType<typeof createClient>,
  params: SearchTripParams
) {
  const fromCity = normalizeCity(params.from_city);
  const toCity = normalizeCity(params.to_city);
  const targetDate = params.date;
  const tripType = params.trip_type || 'all';

  const { currentDate, currentTime } = getDushanbeDateTime();
  const results: Record<string, unknown>[] = [];

  // 1. Search Carpool Rides (excluding passenger requests)
  if (tripType === 'all' || tripType === 'rides') {
    let q = supabase
      .from('rides')
      .select('id,from_city,to_city,date,time,price,total_seats,seats,reserved_seats,allows_delivery,scraper_metadata,users:driver_id(name,rating,role),bookings:bookings(id,seat_number)')
      .eq('status', 'active')
      .eq('is_passenger_entry', false)
      .or(`date.gt.${currentDate},and(date.eq.${currentDate},time.gte.${currentTime})`)
      .order('date', { ascending: true })
      .order('time', { ascending: true })
      .limit(6);

    if (fromCity) q = q.ilike('from_city', `%${fromCity}%`);
    if (toCity) q = q.ilike('to_city', `%${toCity}%`);
    if (targetDate && targetDate >= currentDate) q = q.eq('date', targetDate);

    const { data: ridesData, error: ridesErr } = await q;
    if (!ridesErr && Array.isArray(ridesData)) {
      for (const r of ridesData) {
        // Deduplicate occupied seat numbers between reserved_seats and bookings
        const occupiedSeats = new Set<string | number>();
        if (Array.isArray(r.reserved_seats)) {
          for (const s of r.reserved_seats) {
            if (s !== null && s !== undefined && s !== '') {
              occupiedSeats.add(Number(s) || s);
            }
          }
        } else if (typeof r.reserved_seats === 'string') {
          try {
            const parsed = JSON.parse(r.reserved_seats);
            if (Array.isArray(parsed)) {
              for (const s of parsed) {
                if (s !== null && s !== undefined && s !== '') {
                  occupiedSeats.add(Number(s) || s);
                }
              }
            }
          } catch {
            // Ignore JSON parse error
          }
        }

        let nonNumberedBookings = 0;
        if (Array.isArray(r.bookings)) {
          for (const b of r.bookings) {
            if (b && b.seat_number !== null && b.seat_number !== undefined && b.seat_number !== '') {
              occupiedSeats.add(Number(b.seat_number) || b.seat_number);
            } else if (b && b.id !== undefined) {
              nonNumberedBookings++;
            }
          }
        }

        const totalOccupied = occupiedSeats.size + nonNumberedBookings;
        // seats represents passenger booking capacity (e.g. 3). Fallback to total_seats - 1 if seats is missing.
        const passengerCapacity = Number(r.seats !== undefined && r.seats !== null ? r.seats : Math.max(1, (r.total_seats || 4) - 1));
        // Strict boundary: 0 <= availableSeats <= passengerCapacity
        const availableSeats = Math.max(0, Math.min(passengerCapacity, passengerCapacity - totalOccupied));

        // Strict filter: only offer rides with seats available
        if (availableSeats <= 0) continue;

        // Carrier name priority:
        // 1. scraper_metadata.first_name (+ last_name)
        // 2. users.name
        // 3. Fallback neutral: 'Водитель'
        const driver = Array.isArray(r.users) ? r.users[0] : (r.users || {});
        let driverName = '';

        if (r.scraper_metadata) {
          try {
            const meta = typeof r.scraper_metadata === 'string' ? JSON.parse(r.scraper_metadata) : r.scraper_metadata;
            if (meta && typeof meta.first_name === 'string' && meta.first_name.trim()) {
              driverName = meta.first_name.trim() + (meta.last_name && typeof meta.last_name === 'string' && meta.last_name.trim() ? ' ' + meta.last_name.trim() : '');
            }
          } catch {
            // Ignore JSON parse error
          }
        }

        if (!driverName && driver && typeof driver.name === 'string' && driver.name.trim()) {
          driverName = driver.name.trim();
        }

        if (!driverName) {
          driverName = 'Водитель';
        }

        results.push({
          type: 'carpool',
          id: r.id,
          from_city: r.from_city,
          to_city: r.to_city,
          date: r.date,
          time: r.time ? String(r.time).slice(0, 5) : '12:00',
          price_somoni: r.price,
          seats_available: availableSeats,
          allows_delivery: !!r.allows_delivery,
          driver_name: driverName,
          driver_rating: driver.rating || 5.0,
          verified: driver.role === 'driver',
          booking_path: `/ride/${r.id}`
        });
      }
    }
  }

  // 2. Search Bus Tickets
  if (tripType === 'all' || tripType === 'bus_tickets') {
    let bq = supabase
      .from('bus_tickets')
      .select('id,transport_company,from_city,to_city,departure_date,departure_time,price,total_seats,reserved_seats,duration_minutes,intermediate_stops')
      .eq('status', 'active')
      .or(`departure_date.gt.${currentDate},and(departure_date.eq.${currentDate},departure_time.gte.${currentTime})`)
      .order('departure_date', { ascending: true })
      .order('departure_time', { ascending: true })
      .limit(6);

    if (fromCity) bq = bq.ilike('from_city', `%${fromCity}%`);
    if (targetDate && targetDate >= currentDate) bq = bq.eq('departure_date', targetDate);

    const { data: busData, error: busErr } = await bq;
    if (!busErr && Array.isArray(busData)) {
      for (const b of busData) {
        // Intermediate stops destination check if direct to_city does not match
        let destinationMatches = true;
        if (toCity) {
          const directMatch = (b.to_city || '').toLowerCase().includes(toCity.toLowerCase());
          let stopMatch = false;
          if (!directMatch && b.intermediate_stops) {
            const stops = typeof b.intermediate_stops === 'string' ? JSON.parse(b.intermediate_stops) : b.intermediate_stops;
            if (Array.isArray(stops)) {
              stopMatch = stops.some((s: { city?: string }) => (s.city || '').toLowerCase().includes(toCity.toLowerCase()));
            }
          }
          destinationMatches = directMatch || stopMatch;
        }

        if (!destinationMatches) continue;

        const reservedCount = Array.isArray(b.reserved_seats) ? b.reserved_seats.length : 0;
        const totalCapacity = Number(b.total_seats || 53);
        const availableSeats = Math.max(0, totalCapacity - reservedCount);

        if (availableSeats <= 0) continue;

        results.push({
          type: 'bus',
          id: b.id,
          transport_company: b.transport_company || 'POPUTKI.ONLINE',
          from_city: b.from_city,
          to_city: b.to_city,
          date: b.departure_date,
          time: b.departure_time ? String(b.departure_time).slice(0, 5) : '08:00',
          departure_date: b.departure_date,
          departure_time: b.departure_time ? String(b.departure_time).slice(0, 5) : '08:00',
          price_somoni: b.price,
          seats_available: availableSeats,
          duration_hours: b.duration_minutes ? Math.round(b.duration_minutes / 60) : null,
          booking_path: `/bus-ticket/${b.id}`
        });
      }
    }
  }

  return results.slice(0, 4);
}

async function callClaudeWithTools(
  supabase: ReturnType<typeof createClient>,
  anthropicApiKey: string,
  model: string,
  messages: Array<Record<string, unknown>>
): Promise<{ reply: string; structuredTrips: Record<string, unknown>[]; tokensUsed: number }> {
  const tools = [
    {
      name: 'search_trips',
      description: 'Ищет актуальные доступные автобусные билеты и попутки в базе данных POPUTKI.ONLINE. Возвращает только будущие рейсы со свободными местами.',
      input_schema: {
        type: 'object',
        properties: {
          from_city: { type: 'string', description: 'Город отправления (Худжанд, Душанбе, Бохтар и т.д.)' },
          to_city: { type: 'string', description: 'Город назначения (Москва, Тюмень, Сургут, Душанбе и т.д.)' },
          date: { type: 'string', description: 'Дата поездки в формате YYYY-MM-DD' },
          trip_type: { type: 'string', enum: ['all', 'bus_tickets', 'rides'], description: 'Тип транспорта' }
        }
      }
    }
  ];

  let currentMessages = [...messages];
  const allFoundTrips: Record<string, unknown>[] = [];
  let totalTokens = 0;

  for (let loop = 0; loop < 2; loop++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    let resp: Response;
    try {
      resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicApiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model,
          max_tokens: 600,
          system: SYSTEM_PROMPT,
          tools,
          messages: currentMessages
        }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      throw new Error(`ANTHROPIC_API_ERROR_${resp.status}: ${errBody.slice(0, 100)}`);
    }

    const data = await resp.json();
    totalTokens += (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0);

    if (data.stop_reason === 'tool_use') {
      const toolBlock = data.content?.find((b: { type: string }) => b.type === 'tool_use');
      if (toolBlock && toolBlock.name === 'search_trips') {
        const found = await searchTrips(supabase, toolBlock.input || {});
        allFoundTrips.push(...found);

        currentMessages.push({ role: 'assistant', content: data.content });
        currentMessages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolBlock.id,
              content: JSON.stringify(found.length ? found : [{ message: 'Рейсы не найдены' }])
            }
          ]
        });
      } else {
        break;
      }
    } else {
      const reply = data.content?.find((b: { type: string; text?: string }) => b.type === 'text')?.text || '';
      return { reply, structuredTrips: allFoundTrips, tokensUsed: totalTokens };
    }
  }

  return {
    reply: 'Не удалось получить полную информацию о рейсах. Пожалуйста, воспользуйтесь поиском в приложении.',
    structuredTrips: allFoundTrips,
    tokensUsed: totalTokens
  };
}

Deno.serve(async (req: Request) => {
  const startTime = Date.now();

  // 1. Strict HTTP Method filter
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Bot-Service-Secret'
      }
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // 2. Server-to-Server Authentication Guard
  const expectedSecret = Deno.env.get('INTERNAL_BOT_ASSISTANT_SECRET');
  const providedSecret = req.headers.get('X-Bot-Service-Secret') || '';

  if (!expectedSecret || !timingSafeEqualStr(providedSecret, expectedSecret)) {
    return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // 3. Global Feature Flag Kill Switch
  const isEnabled = Deno.env.get('AI_ASSISTANT_ENABLED') === 'true';
  if (!isEnabled) {
    return new Response(JSON.stringify({ error: 'AI_ASSISTANT_DISABLED' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // 4. Validate Environment Configuration
  const anthropicApiKey = Deno.env.get('ANTHROPIC_API_KEY');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const model = Deno.env.get('ANTHROPIC_MODEL') || 'claude-sonnet-5';

  if (!anthropicApiKey || !supabaseUrl || !supabaseServiceKey) {
    return new Response(JSON.stringify({ error: 'SERVICE_UNCONFIGURED' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // 5. Input Validation
  let payload: RequestPayload;
  try {
    payload = await req.json();
  } catch (_) {
    return new Response(JSON.stringify({ error: 'INVALID_JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const { telegram_id, chat_id, message, request_id } = payload;

  if (
    typeof telegram_id !== 'number' ||
    telegram_id <= 0 ||
    typeof chat_id !== 'number' ||
    typeof message !== 'string' ||
    message.trim().length === 0 ||
    message.length > 1000 ||
    typeof request_id !== 'string' ||
    !/^[a-zA-Z0-9_\-:]{8,64}$/.test(request_id)
  ) {
    return new Response(JSON.stringify({ error: 'INVALID_PAYLOAD' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  // 6. Atomic Persistent Rate Limiter & Idempotency Check
  const burstLimit = Number(Deno.env.get('AI_BURST_LIMIT') || 2);
  const dailyLimit = Number(Deno.env.get('AI_DAILY_USER_LIMIT') || 5);
  const globalLimit = Number(Deno.env.get('AI_GLOBAL_DAILY_LIMIT') || 500);

  const { data: limitCheck, error: limitErr } = await supabase.rpc('check_and_record_ai_request', {
    p_telegram_id: telegram_id,
    p_request_id: request_id,
    p_burst_limit: burstLimit,
    p_daily_limit: dailyLimit,
    p_global_daily_limit: globalLimit
  });

  if (limitErr || !limitCheck?.allowed) {
    const reason = limitCheck?.reason || 'RATE_LIMITED';
    return new Response(JSON.stringify({ error: reason, status: limitCheck?.status || 'REJECTED' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // 7. Load User Conversation History (service_role only)
  let history: Array<Record<string, unknown>> = [];
  try {
    const { data: session } = await supabase
      .from('chat_sessions')
      .select('messages')
      .eq('telegram_id', telegram_id)
      .maybeSingle();

    if (session?.messages && Array.isArray(session.messages)) {
      history = session.messages.slice(-10); // keep last 10 turns
    }
  } catch (err) {
    // Non-fatal, proceed with empty history
  }

  history.push({ role: 'user', content: message.trim() });

  // 8. Execute LLM with Search Contract
  try {
    const { reply, structuredTrips, tokensUsed } = await callClaudeWithTools(
      supabase,
      anthropicApiKey,
      model,
      history
    );

    history.push({ role: 'assistant', content: reply });

    // 9. Persist History via service_role
    await supabase.from('chat_sessions').upsert({
      telegram_id,
      messages: history.slice(-20),
      last_updated: new Date().toISOString()
    });

    // 10. Update Token Usage in Rate Log
    await supabase
      .from('ai_assistant_request_logs')
      .update({
        tokens_used: tokensUsed,
        status: 'SUCCESS'
      })
      .eq('request_id', request_id);

    const latencyMs = Date.now() - startTime;
    console.log(`[AI-ASSISTANT-AUDIT] req_id=${request_id} tid=${telegram_id} status=OK latency=${latencyMs}ms tokens=${tokensUsed}`);

    return new Response(
      JSON.stringify({
        ok: true,
        reply,
        trips: structuredTrips
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  } catch (err: unknown) {
    const errMessage = err instanceof Error ? err.message : String(err);
    console.error(`[AI-ASSISTANT-ERROR] req_id=${request_id} err=${errMessage.slice(0, 120)}`);

    return new Response(
      JSON.stringify({
        error: 'UPSTREAM_AI_ERROR',
        status: 'FAILED'
      }),
      {
        status: 502,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
});
