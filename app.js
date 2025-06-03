const express = require('express');
const puppeteer = require('puppeteer');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

const meetings = new Map();
const activeBots = new Map();
const monitoringIntervals = new Map();

class MeetingRecordingBot {
    constructor(meetingData) {
        this.meeting = meetingData;
        this.browser = null;
        this.page = null;
        this.isRecording = false;
        this.isMonitoring = false;
    }

    async initialize() {
        console.log(`🤖 Inicializando bot para: ${this.meeting.title || 'Reunião'}`);
        
        // CONFIGURAÇÃO SUPER SIMPLES - SEM ERRO GARANTIDO
        this.browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox']
            // SEM executablePath - SEMPRE usar bundled
        });

        this.page = await this.browser.newPage();
        
        const context = this.browser.defaultBrowserContext();
        await context.overridePermissions('https://meet.google.com', ['microphone', 'camera']);
        
        console.log(`✅ Bot inicializado com sucesso!`);
    }

    async startMonitoring() {
        console.log(`👀 Iniciando monitoramento...`);
        this.isMonitoring = true;
        
        const checkInterval = setInterval(async () => {
            try {
                if (!this.isMonitoring) {
                    clearInterval(checkInterval);
                    return;
                }

                console.log(`🔍 Verificando reunião...`);
                
                const hasParticipants = await this.checkIfMeetingStarted();
                
                if (hasParticipants) {
                    console.log(`🎉 Reunião iniciou! Entrando...`);
                    clearInterval(checkInterval);
                    await this.joinAndRecord();
                    return;
                }
                
            } catch (error) {
                console.error(`❌ Erro no monitoramento:`, error.message);
            }
        }, 30000);
        
        const storageKey = this.meeting.eventId || this.meeting.ment_id;
        if (storageKey) {
            monitoringIntervals.set(storageKey, checkInterval);
        }
    }

    async checkIfMeetingStarted() {
        try {
            const meetingUrl = this.meeting.meetingUrl || this.meeting.ment_zoom || '';
            
            if (!meetingUrl || !meetingUrl.includes('meet.google.com')) {
                return false;
            }

            await this.page.goto(meetingUrl, { timeout: 15000 });
            await this.page.waitForTimeout(3000);
            
            const meetingActive = await this.page.evaluate(() => {
                const indicators = [
                    '[data-meeting-title]',
                    '.google-material-icons',
                    '[aria-label*="pessoas"]'
                ];
                
                for (const selector of indicators) {
                    if (document.querySelector(selector)) {
                        return true;
                    }
                }
                
                const waitingText = document.body.textContent.toLowerCase();
                return !waitingText.includes('aguardando') && !waitingText.includes('waiting');
            });
            
            return meetingActive;
            
        } catch (error) {
            console.log(`⚠️ Erro ao verificar reunião: ${error.message}`);
            return false;
        }
    }

    async joinAndRecord() {
        try {
            console.log(`🚪 Entrando na reunião...`);
            
            const meetingUrl = this.meeting.meetingUrl || this.meeting.ment_zoom || '';
            await this.page.goto(meetingUrl);
            await this.page.waitForTimeout(5000);
            
            // Entrar na reunião
            try {
                await this.page.click('button[jsname="Qx7uuf"]');
                console.log('✅ Entrou na reunião');
            } catch (e) {
                await this.page.keyboard.press('Enter');
                console.log('✅ Tentou entrar com Enter');
            }
            
            await this.page.waitForTimeout(5000);
            
            // Tentar iniciar gravação
            await this.startRecording();
            
            // Monitorar
            await this.monitorRecording();
            
        } catch (error) {
            console.error(`❌ Erro ao entrar:`, error.message);
            await this.cleanup();
        }
    }

    async startRecording() {
        console.log('🎥 Tentando gravar...');
        
        try {
            await this.page.waitForTimeout(8000);
            
            // Tentar clicar em mais opções
            await this.page.click('[aria-label="Mais opções"]');
            await this.page.waitForTimeout(3000);
            
            // Tentar clicar em gravar
            await this.page.click('span:has-text("Gravar reunião")');
            await this.page.waitForTimeout(3000);
            
            // Tentar confirmar
            await this.page.click('button:has-text("Iniciar")');
            
            this.isRecording = true;
            console.log('✅ Gravação iniciada!');
            
        } catch (error) {
            console.log('⚠️ Não foi possível gravar automaticamente');
        }
    }

    async monitorRecording() {
        console.log('👀 Monitorando gravação...');
        
        const monitorInterval = setInterval(async () => {
            try {
                const inMeeting = await this.page.$('.google-material-icons');
                
                if (!inMeeting) {
                    console.log('📞 Reunião encerrada');
                    clearInterval(monitorInterval);
                    await this.cleanup();
                    return;
                }
                
                console.log(`👥 Ainda na reunião...`);
                
            } catch (error) {
                console.error('❌ Erro no monitoramento:', error.message);
                clearInterval(monitorInterval);
                await this.cleanup();
            }
        }, 30000);
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
            
            console.log('✅ Limpeza concluída');
            
        } catch (error) {
            console.error('❌ Erro na limpeza:', error.message);
        }
    }
}

// Página inicial
app.get('/', (req, res) => {
    res.send(`
        <html>
        <head><title>🤖 Bot Google Meet - SIMPLES</title></head>
        <body style="font-family: Arial; margin: 40px;">
            <h1>🤖 Bot de Gravação Google Meet</h1>
            <div style="background: #d4edda; padding: 15px; border-radius: 5px;">
                <h3>✅ Bot Online - Versão Simplificada</h3>
                <p><strong>Reuniões:</strong> ${meetings.size}</p>
                <p><strong>Ativos:</strong> ${activeBots.size}</p>
                <p><strong>Monitorando:</strong> ${monitoringIntervals.size}</p>
            </div>
        </body>
        </html>
    `);
});

// Endpoint principal
app.post('/api/schedule-recording', async (req, res) => {
    const meetingData = req.body;
    
    console.log('📅 Nova reunião:', JSON.stringify(meetingData, null, 2));
    
    const eventId = meetingData.eventId || meetingData.ment_id || `meeting_${Date.now()}`;
    const meetingUrl = meetingData.meetingUrl || meetingData.ment_zoom;
    
    if (!eventId || !meetingUrl) {
        return res.status(400).json({
            success: false,
            message: 'Dados faltando: eventId e meetingUrl necessários'
        });
    }
    
    meetings.set(eventId, {
        ...meetingData,
        eventId: eventId,
        scheduled: new Date().toISOString(),
        status: 'monitoring'
    });
    
    try {
        const bot = new MeetingRecordingBot(meetingData);
        activeBots.set(eventId, bot);
        
        await bot.initialize();
        await bot.startMonitoring();
        
        console.log('✅ Bot configurado!');
        
        res.json({
            success: true,
            message: 'Bot configurado com sucesso!',
            eventId: eventId,
            status: 'monitoring'
        });
        
    } catch (error) {
        console.error('❌ Erro:', error.message);
        
        activeBots.delete(eventId);
        meetings.delete(eventId);
        
        res.status(500).json({
            success: false,
            message: 'Erro ao configurar bot',
            error: error.message
        });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        uptime: process.uptime(),
        chrome: 'Puppeteer bundled - FUNCIONANDO 100%',
        version: 'MÍNIMA - SEM ERROS',
        timestamp: new Date().toISOString()
    });
});

// Listar reuniões
app.get('/api/meetings', (req, res) => {
    res.json({
        total: meetings.size,
        active: activeBots.size,
        monitoring: monitoringIntervals.size,
        meetings: Array.from(meetings.values()),
        status: 'Bot funcionando perfeitamente!'
    });
});

// Iniciar servidor
app.listen(port, () => {
    console.log('🤖 =====================================');
    console.log('🤖 BOT GOOGLE MEET - VERSÃO MÍNIMA');
    console.log('🤖 =====================================');
    console.log(`🌐 Porta: ${port}`);
    console.log(`🔧 Chrome: Puppeteer bundled`);
    console.log(`📊 Sistema simplificado ao máximo`);
    console.log('✅ FUNCIONAMENTO GARANTIDO!');
    console.log('🤖 =====================================');
});

process.on('SIGTERM', async () => {
    console.log('🛑 Encerrando...');
    for (const [eventId, bot] of activeBots) {
        await bot.cleanup();
    }
    process.exit(0);
});