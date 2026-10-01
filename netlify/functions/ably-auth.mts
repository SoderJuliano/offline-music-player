import * as Ably from 'ably';

export default async (req: Request) => {
  // Obter chave da API do Ably das variáveis de ambiente do Netlify
  const apiKey = process.env.VITE_ABLY_API_KEY || process.env.ABLY_API_KEY;

  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'Chave VITE_ABLY_API_KEY não configurada no Netlify' }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );
  }

  try {
    const client = new Ably.Rest(apiKey);
    // Cria requisição de token assinada no backend do Netlify
    const tokenRequest = await client.auth.createTokenRequest({
      clientId: 'user_' + Math.random().toString(36).substring(2, 11),
      capability: { '*': ['*'] },
    });

    return new Response(JSON.stringify(tokenRequest), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message || 'Erro ao gerar token do Ably' }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );
  }
};
