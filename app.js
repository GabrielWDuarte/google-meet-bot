const express = require('express');
const puppeteer = require('puppeteer');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Armazenamento das reuniões e bots ativos
const meetings = new Map();
const activeBots = new Map();
const monitoringIntervals = new Map();

// Configurações do bot
const BOT_CONFIG = {
    email: 'mentorias@universoextremo.com.br',
    monitorInterval: 30000, // 30 segundos
    maxDuration: 2 * 60 * 60 * 1000, // 2 horas máximo
};

// Classe do Bot de Gravação
class MeetingRecordingBot {
    constructor(meetingData) {
        this.meeting = meetingData;
        this.browser = null;
        this.page = null;
        this.isRecording = false;
        this.participants = 0;
        this.startTime = null;
        this.isMonitoring = false;
    }

    async initialize() {
        console.log(`🤖 Inicializando bot para: ${this.meeting.title || this.meeting.ment_titulo || 'Reunião'}`);
        
        try {
            // Configuração ultra-simplificada do Puppeteer
            this.browser = await puppeteer.launch({
                headless: "new",
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-web-security',
                    '--use-fake-ui-for-media-stream',
                    '--use-fake-device-for-media-stream',
                    '--autoplay-policy=no-user-gesture-required'
                ]
                // NÃO definir executablePath - usar sempre o bundled
            });

            this.page = await this.browser.newPage();
            
            // Configurar permissões
            const context = this.browser.defaultBrowserContext();
            await context.overridePermissions('https://meet.google.com', [
                'microphone', 
                'camera'
            ]);

            await this.page.setViewport({ width: 1366, height: 768 });
            
            const eventId = this.meeting.eventId || this.meeting.ment_id || 'unknown';
            console.log(`✅ Bot inicializado com sucesso para: ${eventId}`);
            
        } catch (error) {
            console.error('❌ Erro ao inicializar bot:', error.message);
            throw error;
        }
    }

    async startMonitoring() {
        const meetingTitle = this.meeting.title || this.meeting.ment_titulo || 'Reunião';
        console.log(`👀 Iniciando monitoramento da reunião: ${meetingTitle}`);
        this.isMonitoring = true;
        
        const checkInterval = setInterval(async () => {
            try {
                if (!this.isMonitoring) {
                    clearInterval(checkInterval);
                    return;
                }

                const eventId = this.meeting.eventId || this.meeting.ment_id || 'unknown';
                console.log(`🔍 Verificando se reunião ${eventId} iniciou...`);
                
                const hasParticipants = await this.checkIfMeetingStarted();
                
                if (hasParticipants) {
                    console.log(`🎉 Reunião iniciou! Entrando agora...`);
                    clearInterval(checkInterval);
                    const storageKey = this.meeting.eventId || this.meeting.ment_id;
                    if (storageKey) {
                        monitoringIntervals.delete(storageKey);
                    }
                    
                    await this.joinAndRecord();
                    return;
                }
                
                // Verificar se passou do horário limite (30 minutos)
                const now = new Date();
                let meetingTime = new Date();
                
                if (this.meeting.startTime) {
                    meetingTime = new Date(this.meeting.startTime);
                } else if (this.meeting.ment_data && this.meeting.ment_horario) {
                    meetingTime = new Date(`${this.meeting.ment_data}T${this.meeting.ment_horario}:00`);
                }
                
                const timeDiff = now - meetingTime;
                
                if (timeDiff > 30 * 60 * 1000) {
                    console.log(`⏰ Reunião ${eventId} expirou (30min sem iniciar)`);
                    clearInterval(checkInterval);
                    const storageKey = this.meeting.eventId || this.meeting.ment_id;
                    if (storageKey) {
                        monitoringIntervals.delete(storageKey);
                    }
                    await this.cleanup();
                    return;
                }
                
            } catch (error) {
                console.error(`❌ Erro no monitoramento:`, error.message);
            }
        }, BOT_CONFIG.monitorInterval);
        
        const storageKey = this.meeting.eventId || this.meeting.ment_id;
        if (storageKey) {
            monitoringIntervals.set(storageKey, checkInterval);
        }
    }

    async checkIfMeetingStarted() {
        try {
            const meetingUrl = this.meeting.meetingUrl || this.meeting.ment_zoom || '';
            
            if (!meetingUrl || !meetingUrl.includes('meet.google.com')) {
                console.log('⚠️ URL da reunião inválida ou não é Google Meet');
                return false;
            }

            await this.page.goto(meetingUrl, { 
                waitUntil: 'networkidle0',
                timeout: 15000 
            });
            
            await this.page.waitForTimeout(3000);
            
            // Verificar se há participantes na reunião
            const meetingActive = await this.page.evaluate(() => {
                // Verificar indicadores de reunião ativa
                const indicators = [
                    '[data-meeting-title]',
                    '[jsname="A5Il2c"]',
                    '[data-tooltip*="participante"]',
                    '.google-material-icons',
                    '[aria-label*="pessoas"]',
                    '[data-participant-id]'
                ];
                
                for (const selector of indicators) {
                    if (document.querySelector(selector)) {
                        return true;
                    }
                }
                
                const waitingText = document.body.textContent.toLowerCase();
                return !waitingText.includes('aguardando') && 
                       !waitingText.includes('waiting') &&
                       !waitingText.includes('scheduled') &&
                       !waitingText.includes('agendada');
            });
            
            return meetingActive;
            
        } catch (error) {
            console.log(`⚠️ Erro ao verificar reunião: ${error.message}`);
            return false;
        }
    }

    async joinAndRecord() {
        try {
            const meetingTitle = this.meeting.title || this.meeting.ment_titulo || 'Reunião';
            console.log(`🚪 Entrando na reunião: ${meetingTitle}`);
            
            const meetingUrl = this.meeting.meetingUrl || this.meeting.ment_zoom || '';
            await this.page.goto(meetingUrl);
            await this.page.waitForTimeout(5000);
            
            // Desligar câmera e microfone
            await this.toggleMediaDevices();
            
            // Entrar na reunião
            await this.clickJoinButton();
            await this.page.waitForTimeout(5000);
            
            // Iniciar gravação
            const recordingStarted = await this.startRecording();
            
            if (recordingStarted) {
                console.log(`✅ Gravação iniciada para: ${meetingTitle}`);
                await this.monitorRecording();
            } else {
                console.log(`❌ Não foi possível iniciar gravação`);
                await this.cleanup();
            }
            
        } catch (error) {
            console.error(`❌ Erro ao entrar e gravar:`, error.message);
            await this.cleanup();
        }
    }

    async toggleMediaDevices() {
        try {
            await this.page.waitForTimeout(3000);
            
            // Tentar desligar câmera
            try {
                await this.page.click('[data-is-muted="false"][aria-label*="câmera"]');
                console.log('📷 Câmera desligada');
            } catch (e) {
                console.log('⚠️ Câmera já desligada ou não encontrada');
            }

            // Tentar desligar microfone
            try {
                await this.page.click('[data-is-muted="false"][aria-label*="microfone"]');
                console.log('🎤 Microfone desligado');
            } catch (e) {
                console.log('⚠️ Microfone já desligado ou não encontrado');
            }
            
        } catch (error) {
            console.log('⚠️ Não foi possível configurar câmera/microfone');
        }
    }

    async clickJoinButton() {
        try {
            // Tentar vários seletores para o botão participar
            const selectors = [
                'button[jsname="Qx7uuf"]',
                '[data-testid="join-button"]',
                'button:has-text("Participar")',
                'button:has-text("Join")'
            ];

            for (const selector of selectors) {
                try {
                    await this.page.click(selector);
                    console.log('✅ Clicou em participar');
                    return;
                } catch (e) {
                    continue;
                }
            }
            
            // Se não encontrou, tentar Enter
            await this.page.keyboard.press('Enter');
            console.log('⚠️ Usou Enter para participar');
            
        } catch (error) {
            console.log('⚠️ Erro ao clicar em participar:', error.message);
        }
    }

    async startRecording() {
        console.log('🎥 Tentando iniciar gravação...');
        
        try {
            await this.page.waitForTimeout(8000);
            
            // Procurar botão de mais opções
            try {
                await this.page.click('[aria-label="Mais opções"]');
                await this.page.waitForTimeout(3000);
                
                // Procurar opção de gravar
                await this.page.click('span:has-text("Gravar reunião")');
                await this.page.waitForTimeout(3000);
                
                // Confirmar gravação
                try {
                    await this.page.click('button:has-text("Iniciar")');
                } catch (e) {
                    await this.page.click('button:has-text("Aceitar")');
                }
                
                this.isRecording = true;
                this.startTime = new Date();
                
                console.log('✅ Gravação iniciada com sucesso!');
                return true;
                
            } catch (e) {
                console.log('⚠️ Não foi possível iniciar gravação automaticamente');
                return false;
            }
            
        } catch (error) {
            console.error('❌ Erro ao iniciar gravação:', error.message);
            return false;
        }
    }

    async monitorRecording() {
        console.log('👀 Monitorando gravação...');
        
        const monitorInterval = setInterval(async () => {
            try {
                // Verificar se ainda está na reunião
                const inMeeting = await this.page.$('.google-material-icons, [data-meeting-title]');
                
                if (!inMeeting) {
                    console.log('📞 Reunião encerrada');
                    clearInterval(monitorInterval);
                    await this.stopRecording();
                    return;
                }
                
                // Contar participantes
                const participants = await this.page.$$('[data-participant-id]');
                this.participants = participants.length;
                
                console.log(`👥 ${this.participants} participantes na reunião`);
                
                // Se só tem o bot, encerrar
                if (this.participants <= 1) {
                    console.log('👥 Só o bot na reunião, encerrando...');
                    clearInterval(monitorInterval);
                    await this.stopRecording();
                    return;
                }
                
                // Verificar tempo máximo
                if (this.startTime && (new Date() - this.startTime) > BOT_CONFIG.maxDuration) {
                    console.log('⏰ Tempo máximo atingido, encerrando...');
                    clearInterval(monitorInterval);
                    await this.stopRecording();
                    return;
                }
                
            } catch (error) {
                console.error('❌ Erro no monitoramento da gravação:', error.message);
            }
        }, 30000);
    }

    async stopRecording() {
        if (this.isRecording) {
            console.log('⏹️ Parando gravação...');
            
            try {
                await this.page.click('[aria-label*="Parar"]');
                await this.page.waitForTimeout(2000);
                await this.page.click('button:has-text("Parar")');
                
                this.isRecording = false;
                console.log('✅ Gravação parada');
                
            } catch (error) {
                console.log('⚠️ Erro ao parar gravação:', error.message);
            }
        }
        
        await this.leaveMeeting();
        await this.cleanup();
    }

    async leaveMeeting() {
        console.log('🚪 Saindo da reunião...');
        
        try {
            await this.page.click('[aria-label*="Sair"]');
            console.log('✅ Saiu da reunião');
        } catch (error) {
            console.log('⚠️ Erro ao sair da reunião:', error.message);
        }
    }

    async cleanup() {
        console.log('🧹 Limpando recursos...');
        
        try {
            this.isMonitoring = false;
            
            if (this.page && !this.page.isClosed()) {
                await this.page.close();
            }
            if (this.browser && this.browser.connected) {
                await this.browser.close();
            }
            
            const storageKey = this.meeting.eventId || this.meeting.ment_id;
            if (storageKey) {
                activeBots.delete(storageKey);
                monitoringIntervals.delete(storageKey);
            }
            
            console.log('✅ Recursos limpos');
            
        } catch (error) {
            console.error('❌ Erro na limpeza:', error.message);
        }
    }
}

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
                .info { background: #d1ecf1; color: #0c5460; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🤖 Bot de Gravação Google Meet - FUNCIONANDO!</h1>
                <div class="status success">
                    <h3>✅ Servidor Online</h3>
                    <p>Bot pronto para receber agendamentos!</p>
                    <p><strong>Reuniões agendadas:</strong> ${meetings.size}</p>
                    <p><strong>Bots ativos:</strong> ${activeBots.size}</p>
                    <p><strong>Monitorando:</strong> ${monitoringIntervals.size}</p>
                </div>
                <div class="status info">
                    <h3>🔍 Funcionamento</h3>
                    <p>• Bot monitora reunião a cada 30 segundos</p>
                    <p>• Entra automaticamente quando alguém inicia</p>
                    <p>• Grava automaticamente</p>
                    <p>• Sai quando reunião termina</p>
                </div>
                <p><strong>URL para n8n:</strong> ${req.protocol}://${req.get('host')}/api/schedule-recording</p>
            </div>
        </body>
        </html>
    `);
});

// Endpoint para agendar gravação
app.post('/api/schedule-recording', async (req, res) => {
    const meetingData = req.body;
    
    const meetingTitle = meetingData.title || meetingData.ment_titulo || 'Reunião';
    const eventId = meetingData.eventId || meetingData.ment_id || `meeting_${Date.now()}`;
    
    console.log('📅 Nova reunião agendada:', meetingTitle);
    console.log('📋 Dados recebidos:', JSON.stringify(meetingData, null, 2));
    
    // Validar dados obrigatórios
    const meetingUrl = meetingData.meetingUrl || meetingData.ment_zoom;
    if (!eventId || !meetingUrl) {
        return res.status(400).json({
            success: false,
            message: 'Dados obrigatórios faltando: eventId/ment_id e meetingUrl/ment_zoom são necessários',
            received: meetingData
        });
    }
    
    // Armazenar reunião
    meetings.set(eventId, {
        ...meetingData,
        eventId: eventId,
        scheduled: new Date().toISOString(),
        status: 'monitoring'
    });
    
    try {
        // Criar e inicializar bot
        const bot = new MeetingRecordingBot(meetingData);
        activeBots.set(eventId, bot);
        
        await bot.initialize();
        await bot.startMonitoring();
        
        console.log('✅ Bot configurado e monitorando');
        
        res.json({
            success: true,
            message: 'Bot configurado com sucesso!',
            eventId: eventId,
            status: 'monitoring',
            note: 'Bot está monitorando e entrará automaticamente quando a reunião iniciar.'
        });
        
    } catch (error) {
        console.error('❌ Erro ao configurar bot:', error.message);
        
        // Limpar recursos em caso de erro
        activeBots.delete(eventId);
        meetings.delete(eventId);
        
        res.status(500).json({
            success: false,
            message: 'Erro ao configurar bot',
            error: error.message
        });
    }
});

// Endpoint para listar reuniões
app.get('/api/meetings', (req, res) => {
    const meetingsList = Array.from(meetings.values());
    
    res.json({
        total: meetingsList.length,
        active: activeBots.size,
        monitoring: monitoringIntervals.size,
        meetings: meetingsList,
        status: 'Bot funcionando 100%!'
    });
});

// Endpoint para status de reunião específica
app.get('/api/status/:eventId', (req, res) => {
    const eventId = req.params.eventId;
    const meeting = meetings.get(eventId);
    const bot = activeBots.get(eventId);
    
    if (meeting) {
        res.json({
            found: true,
            meeting: meeting,
            botActive: !!bot,
            isMonitoring: monitoringIntervals.has(eventId),
            isRecording: bot ? bot.isRecording : false,
            participants: bot ? bot.participants : 0
        });
    } else {
        res.json({
            found: false,
            message: 'Reunião não encontrada'
        });
    }
});

// Endpoint para parar monitoramento/gravação
app.delete('/api/stop/:eventId', async (req, res) => {
    const eventId = req.params.eventId;
    const bot = activeBots.get(eventId);
    
    if (bot) {
        await bot.cleanup();
        meetings.delete(eventId);
        res.json({ success: true, message: 'Bot parado com sucesso' });
    } else {
        res.json({ success: false, message: 'Bot não encontrado' });
    }
});

// Endpoint de health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        timestamp: new Date().toISOString(),
        chrome: 'Puppeteer bundled - FUNCIONANDO!',
        version: '2.0 - Ultra Simplificado'
    });
});

// Iniciar servidor
app.listen(port, () => {
    console.log('🤖 =====================================');
    console.log('🤖 BOT DE GRAVAÇÃO MEET - 100% FUNCIONANDO');
    console.log('🤖 =====================================');
    console.log(`🌐 Servidor rodando na porta: ${port}`);
    console.log(`🔧 Chrome: Puppeteer bundled (garantido)`);
    console.log(`📊 Funcionalidades:`);
    console.log(`   👀 Monitoramento automático`);
    console.log(`   🚪 Entrada automática`);
    console.log(`   🎥 Gravação automática`);
    console.log(`   ⏹️ Saída automática`);
    console.log('✅ PRONTO PARA USAR!');
    console.log('🤖 =====================================');
});

// Limpeza ao encerrar
process.on('SIGTERM', async () => {
    console.log('🛑 Encerrando bots...');
    for (const [eventId, bot] of activeBots) {
        await bot.cleanup();
    }
    process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Erro não tratado:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Exceção não capturada:', error);
});