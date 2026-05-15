import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  try {
    const { searchParams } = new URL(req.url);
    const query    = searchParams.get("query")    || "futebol";
    const language = searchParams.get("language") || "pt";
    const category = searchParams.get("category") || "sports";

    const API_KEY = Deno.env.get("NEWSDATA_API_KEY");
    if (!API_KEY) {
      return new Response(JSON.stringify({ status: "error", message: "API key não configurada" }), {
        status: 500,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const apiUrl = `https://newsdata.io/api/1/latest?apikey=${API_KEY}&q=${encodeURIComponent(query)}&language=${language}&category=${category}`;
    const res  = await fetch(apiUrl);
    const data = await res.json();

    return new Response(JSON.stringify(data), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ status: "error", message: String(err) }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
