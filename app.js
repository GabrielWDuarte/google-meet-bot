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
    headless: true, // True para produção
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
        console.log(`🤖 Inicializando bot para: ${this.meeting.title}`);
        
        this.browser = await puppeteer.launch({
            headless: BOT_CONFIG.headless,
            userDataDir: './bot-session',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--use-fake-ui-for-media-stream',
                '--use-fake-device-for-media-stream',
                '--disable-features=VizDisplayCompositor',
                '--autoplay-policy=no-user-gesture-required',
                '--disable-web-security'
            ]
        });

        this.page = await this.browser.newPage();
        
        // Configurar permissões
        const context = this.browser.defaultBrowserContext();
        await context.overridePermissions('https://meet.google.com', [
            'microphone', 'camera'
        ]);

        await this.page.setViewport({ width: 1366, height: 768 });
        console.log(`✅ Bot inicializado para: ${this.meeting.eventId}`);
    }

    async startMonitoring() {
        console.log(`👀 Iniciando monitoramento da reunião: ${this.meeting.title}`);
        this.isMonitoring = true;
        
        const checkInterval = setInterval(async () => {
            try {
                if (!this.isMonitoring) {
                    clearInterval(checkInterval);
                    return;
                }

                console.log(`🔍 Verificando se reunião ${this.meeting.eventId} iniciou...`);
                
                const hasParticipants = await this.checkIfMeetingStarted();
                
                if (hasParticipants) {
                    console.log(`🎉 Reunião iniciou! Entrando agora...`);
                    clearInterval(checkInterval);
                    monitoringIntervals.delete(this.meeting.eventId);
                    
                    await this.joinAndRecord();
                    return;
                }
                
                // Verificar se passou do horário limite
                const now = new Date();
                const meetingTime = new Date(this.meeting.startTime);
                const timeDiff = now - meetingTime;
                
                if (timeDiff > 30 * 60 * 1000) { // 30 minutos depois
                    console.log(`⏰ Reunião ${this.meeting.eventId} expirou (30min sem iniciar)`);
                    clearInterval(checkInterval);
                    monitoringIntervals.delete(this.meeting.eventId);
                    await this.cleanup();
                    return;
                }
                
            } catch (error) {
                console.error(`❌ Erro no monitoramento:`, error);
            }
        }, BOT_CONFIG.monitorInterval);
        
        monitoringIntervals.set(this.meeting.eventId, checkInterval);
    }

    async checkIfMeetingStarted() {
        try {
            await this.page.goto(this.meeting.meetingUrl, { 
                waitUntil: 'networkidle0',
                timeout: 10000 
            });
            
            await this.page.waitForTimeout(3000);
            
            // Verificar se há participantes na reunião
            // Procurar por elementos que indicam reunião ativa
            const meetingActive = await this.page.evaluate(() => {
                // Verificar se há indicadores de reunião ativa
                const indicators = [
                    '[data-meeting-title]',
                    '[jsname="A5Il2c"]', // Botão mais opções
                    '[data-tooltip*="participante"]',
                    '.google-material-icons',
                    '[aria-label*="pessoas"]'
                ];
                
                for (const selector of indicators) {
                    if (document.querySelector(selector)) {
                        return true;
                    }
                }
                
                // Verificar se não está na tela de "aguardando"
                const waitingText = document.body.textContent;
                return !waitingText.includes('Aguardando') && 
                       !waitingText.includes('Waiting') &&
                       !waitingText.includes('scheduled');
            });
            
            return meetingActive;
            
        } catch (error) {
            console.log(`⚠️ Erro ao verificar reunião: ${error.message}`);
            return false;
        }
    }

    async joinAndRecord() {
        try {
            console.log(`🚪 Entrando na reunião: ${this.meeting.title}`);
            
            await this.page.goto(this.meeting.meetingUrl);
            await this.page.waitForTimeout(5000);
            
            // Desligar câmera e microfone
            await this.toggleMediaDevices();
            
            // Entrar na reunião
            await this.clickJoinButton();
            await this.page.waitForTimeout(3000);
            
            // Iniciar gravação
            const recordingStarted = await this.startRecording();
            
            if (recordingStarted) {
                console.log(`✅ Gravação iniciada para: ${this.meeting.title}`);
                await this.monitorRecording();
            } else {
                console.log(`❌ Não foi possível iniciar gravação`);
            }
            
        } catch (error) {
            console.error(`❌ Erro ao entrar e gravar:`, error);
            await this.cleanup();
        }
    }

    async toggleMediaDevices() {
        try {
            // Desligar câmera
            const cameraBtn = await this.page.$('[data-is-muted="false"][aria-label*="câmera"], [aria-label*="Desativar câmera"]');
            if (cameraBtn) {
                await cameraBtn.click();
                console.log('📷 Câmera desligada');
            }

            // Desligar microfone  
            const micBtn = await this.page.$('[data-is-muted="false"][aria-label*="microfone"], [aria-label*="Desativar microfone"]');
            if (micBtn) {
                await micBtn.click();
                console.log('🎤 Microfone desligado');
            }
        } catch (error) {
            console.log('⚠️ Não foi possível configurar câmera/microfone');
        }
    }

    async clickJoinButton() {
        const selectors = [
            'button[jsname="Qx7uuf"]',
            '[data-testid="join-button"]',
            'button:has-text("Participar")',
            'button:has-text("Join")',
            'div[role="button"]:has-text("Participar")'
        ];

        for (const selector of selectors) {
            try {
                const button = await this.page.$(selector);
                if (button) {
                    await button.click();
                    console.log('✅ Clicou em participar');
                    return;
                }
            } catch (e) {
                continue;
            }
        }
        
        console.log('⚠️ Botão participar não encontrado, tentando Enter');
        await this.page.keyboard.press('Enter');
    }

    async startRecording() {
        console.log('🎥 Iniciando gravação...');
        
        try {
            await this.page.waitForTimeout(5000);
            
            // Procurar botão de mais opções
            const moreButton = await this.page.$('[aria-label="Mais opções"], [data-tooltip="Mais opções"]') ||
                              await this.page.$('button[jsname="A5Il2c"]');
            
            if (moreButton) {
                await moreButton.click();
                await this.page.waitForTimeout(2000);
                
                // Procurar opção de gravar
                const recordOption = await this.page.$('span:has-text("Gravar reunião"), div:has-text("Gravar reunião")');
                
                if (recordOption) {
                    await recordOption.click();
                    await this.page.waitForTimeout(2000);
                    
                    // Confirmar gravação
                    const confirmBtn = await this.page.$('button:has-text("Iniciar"), button:has-text("Aceitar")');
                    if (confirmBtn) {
                        await confirmBtn.click();
                    }
                    
                    this.isRecording = true;
                    this.startTime = new Date();
                    
                    // Configurar transcrição
                    await this.setupTranscription();
                    
                    return true;
                }
            }
            
            console.log('⚠️ Não foi possível encontrar botão de gravação');
            return false;
            
        } catch (error) {
            console.error('❌ Erro ao iniciar gravação:', error);
            return false;
        }
    }

    async setupTranscription() {
        try {
            console.log('📝 Configurando transcrição em português...');
            
            await this.page.waitForTimeout(2000);
            
            // Procurar botão de legendas
            const captionsBtn = await this.page.$('[aria-label*="legenda"], [data-tooltip*="legenda"]');
            
            if (captionsBtn) {
                await captionsBtn.click();
                await this.page.waitForTimeout(1000);
                
                // Procurar configurações de idioma
                const settingsBtn = await this.page.$('[aria-label*="configurações"]');
                if (settingsBtn) {
                    await settingsBtn.click();
                    await this.page.waitForTimeout(1000);
                    
                    // Selecionar português
                    const portugueseOption = await this.page.$('option[value="pt-BR"], span:has-text("Português")');
                    if (portugueseOption) {
                        await portugueseOption.click();
                        console.log('✅ Transcrição configurada para português');
                    }
                }
            }
        } catch (error) {
            console.log('⚠️ Não foi possível configurar transcrição:', error);
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
                const participants = await this.page.$$('[data-participant-id], [jsname="V68bde"]');
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
                console.error('❌ Erro no monitoramento da gravação:', error);
            }
        }, 30000); // A cada 30 segundos
    }

    async stopRecording() {
        if (this.isRecording) {
            console.log('⏹️ Parando gravação...');
            
            try {
                const stopBtn = await this.page.$('[aria-label*="Parar"], button:has-text("Parar gravação")');
                if (stopBtn) {
                    await stopBtn.click();
                    await this.page.waitForTimeout(1000);
                    
                    const confirmBtn = await this.page.$('button:has-text("Parar")');
                    if (confirmBtn) {
                        await confirmBtn.click();
                    }
                }
                
                this.isRecording = false;
                console.log('✅ Gravação parada');
                
            } catch (error) {
                console.error('❌ Erro ao parar gravação:', error);
            }
        }
        
        await this.leaveMeeting();
        await this.cleanup();
    }

    async leaveMeeting() {
        console.log('🚪 Saindo da reunião...');
        
        try {
            const leaveBtn = await this.page.$('[aria-label*="Sair"], [data-tooltip*="Sair"]') ||
                            await this.page.$('button[jsname="CQylAd"]');
            
            if (leaveBtn) {
                await leaveBtn.click();
                console.log('✅ Saiu da reunião');
            }
        } catch (error) {
            console.error('❌ Erro ao sair da reunião:', error);
        }
    }

    async cleanup() {
        console.log('🧹 Limpando recursos...');
        
        try {
            this.isMonitoring = false;
            
            if (this.page) await this.page.close();
            if (this.browser) await this.browser.close();
            
            activeBots.delete(this.meeting.eventId);
            monitoringIntervals.delete(this.meeting.eventId);
            
            console.log('✅ Recursos limpos');
            
        } catch (error) {
            console.error('❌ Erro na limpeza:', error);
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
                <h1>🤖 Bot de Gravação Google Meet</h1>
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
                    <p>• Grava em português automaticamente</p>
                    <p>• Sai quando reunião termina</p>
                </div>
                <p><strong>URL para n8n:</strong> ${req.protocol}://${req.get('host')}/api/schedule-recording</p>
            </div>
        </body>
        </html>
    `);
});

// Endpoint para agendar gravação (usado pelo n8n)
app.post('/api/schedule-recording', async (req, res) => {
    const meetingData = req.body;
    
    console.log('📅 Nova reunião agendada:', meetingData.title || meetingData.eventId);
    
    // Armazenar reunião
    meetings.set(meetingData.eventId, {
        ...meetingData,
        scheduled: new Date().toISOString(),
        status: 'monitoring'
    });
    
    try {
        // Criar e inicializar bot
        const bot = new MeetingRecordingBot(meetingData);
        activeBots.set(meetingData.eventId, bot);
        
        await bot.initialize();
        await bot.startMonitoring();
        
        console.log('✅ Bot configurado e monitorando');
        
        res.json({
            success: true,
            message: 'Bot configurado com sucesso!',
            eventId: meetingData.eventId,
            status: 'monitoring',
            note: 'Bot está monitorando e entrará automaticamente quando a reunião iniciar.'
        });
        
    } catch (error) {
        console.error('❌ Erro ao configurar bot:', error);
        
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
        status: 'Bot funcionando - Monitoramento automático ativo!'
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
            isRecording: bot ? bot.isRecording : false
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
        res.json({ success: true, message: 'Bot parado com sucesso' });
    } else {
        res.json({ success: false, message: 'Bot não encontrado' });
    }
});

// Iniciar servidor
app.listen(port, () => {
    console.log('🤖 =====================================');
    console.log('🤖 BOT DE GRAVAÇÃO GOOGLE MEET ONLINE');
    console.log('🤖 =====================================');
    console.log(`🌐 Servidor rodando na porta: ${port}`);
    console.log(`📊 Funcionalidades:`);
    console.log(`   👀 Monitoramento automático de reuniões`);
    console.log(`   🚪 Entrada automática quando reunião inicia`);
    console.log(`   🎥 Gravação automática em português`);
    console.log(`   ⏹️ Saída automática quando reunião termina`);
    console.log('✅ Pronto para receber dados do n8n!');
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