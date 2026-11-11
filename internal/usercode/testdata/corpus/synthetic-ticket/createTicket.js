/**
 * Synthetic action: creates a ticket through a gateway with a dated payload.
 * @title Create ticket (synthetic)
 * @category Custom
 * @author example
 */
const axios = require('axios')
const moment = require('moment')

const dataTicket = {
  contactPhone: `${session.phone}`,
  channel: 79,
  externalTicketid: '',
  details: `${session.detailKendala}`,
  serviceId: `${session.serviceId}`,
  reportedBy: `${session.name}`,
  classificationPath: `${session.symptom}`,
  summary: `${session.detailKendala}`,
  contactName: `${session.name}`,
  sourceTicket: 'CUSTOMER',
  serviceType: 'WMS'
}

const now = moment().format('YYYY-MM-DD HH:mm:ss.SSS')
bp.logger.info('Today', now)
session.today = now

const createTicket = async (name, value) => {
  try {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.accessToken}`
    }

    const payload = {
      createTicketWithAttributeRequest: {
        eaiHeader: {
          externalId: 'e5d4d90e-d488-4022-a72d-5482fd151781',
          timestamp: `${session.today}`
        },
        eaiBody: {
          dataTicket: dataTicket,
          dataAttribute: [
            { attributeName: '', attributeValue: '' },
            { attributeName: '', attributeValue: '' }
          ]
        }
      }
    }

    bp.logger.info('data payload', payload)

    const apiUrl = 'https://apigw.example.test:7777/gateway/example-service/1.0/createTicketWithAttribute'
    const response = await axios.post(apiUrl, payload, { headers })

    session.statusCreateTiket = response.status
    bp.logger.info('status createTicket', session.statusCreateTiket)

    session.ticketID = response.data.createTicketWithAttributeResponse.eaiBody.ticketId
    session.reportedTime = response.data.createTicketWithAttributeResponse.eaiHeader.responseTimestamp
    bp.logger.info('data ticket', dataTicket)
  } catch (e) {
    bp.logger.error(e)

    session.codeApi = e.response.status
    if (session.codeApi === 400) {
      session.statusNameError = 'Bad Request'
    } else if (session.codeApi === 408) {
      session.statusNameError = 'Request Timed Out'
    } else if (session.codeApi === 500) {
      session.statusNameError = 'Server Error'
    } else {
      session.statusNameError = e.response.status
    }
  }
}

return createTicket(args.name, args.value)
