const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Armazenamento simples das reuniões
const meetings = new Map();
const activeBots = new Map();

// Página inicial com status
app.get('/', (req, res) => {
    res.send(`
        <html>
        <head>
            <title>🤖 Bot de Gravação Google Meet</title>
            <style>
                body { font-family: Arial; margin: 40px; background: #f5f5f5; }
                .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; }
                .status { padding: 15px; margin: 10px 0; border-radius: 5px; }
                .success { background: #d4edda; color: #155724; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🤖 Bot de Gravação Google Meet</h1>
                <div class="status success">
                    <h3>✅ Servidor Online</h3>
                    <p>Bot pronto para receber agendamentos!</p>
                    <p><strong>Reuniões agendadas:</strong> ${meetings.size}</p>
                    <p><strong>URL para n8n:</strong> ${req.protocol}://${req.get('host')}/api/schedule-recording</p>
                </div>
            </div>
        </body>
        </html>
    `);
});

// Endpoint para agendar gravação (usado pelo n8n)
app.post('/api/schedule-recording', (req, res) => {
    const meetingData = req.body;
    
    console.log('📅 Nova reunião agendada:', meetingData.title || meetingData.eventId);
    
    // Armazenar reunião
    meetings.set(meetingData.eventId, {
        ...meetingData,
        scheduled: new Date().toISOString(),
        status: 'scheduled'
    });
    
    console.log('✅ Reunião salva no sistema');
    
    res.json({
        success: true,
        message: 'Reunião agendada com sucesso!',
        eventId: meetingData.eventId,
        scheduledTime: meetingData.startTime,
        note: 'Bot está configurado e funcionando. Em breve implementaremos a gravação automática via Puppeteer.'
    });
});

// Endpoint para listar reuniões
app.get('/api/meetings', (req, res) => {
    const meetingsList = Array.from(meetings.values());
    
    res.json({
        total: meetingsList.length,
        meetings: meetingsList,
        status: 'Bot funcionando perfeitamente!'
    });
});

// Endpoint para status de reunião específica
app.get('/api/status/:eventId', (req, res) => {
    const eventId = req.params.eventId;
    const meeting = meetings.get(eventId);
    
    if (meeting) {
        res.json({
            found: true,
            meeting: meeting
        });
    } else {
        res.json({
            found: false,
            message: 'Reunião não encontrada'
        });
    }
});

// Iniciar servidor
app.listen(port, () => {
    console.log('🤖 =====================================');
    console.log('🤖 BOT DE GRAVAÇÃO GOOGLE MEET ONLINE');
    console.log('🤖 =====================================');
    console.log(`🌐 Servidor rodando na porta: ${port}`);
    console.log(`📊 Endpoints disponíveis:`);
    console.log(`   GET  / - Status do bot`);
    console.log(`   POST /api/schedule-recording - Agendar`);
    console.log(`   GET  /api/meetings - Listar reuniões`);
    console.log('✅ Pronto para receber dados do n8n!');
    console.log('🤖 =====================================');
});
