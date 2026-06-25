sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast",
], (Controller, JSONModel, MessageToast, ExtensionAPI) => {
  "use strict";

  return Controller.extend("tum.userchatbot.controller.UserChatbot", {
    onInit: function () {
      const oModel = new JSONModel({
        messages: []
      });
      this.getView().setModel(oModel);
    },
    onAfterRendering: function () {
      // Get the problematic parent element
      const oParentElement = this.byId("chatInput").$().parent();

      // Adjust the styles dynamically
      oParentElement.css({
        "min-width": "0", // Override problematic min-width
        "flex": "1 1 auto" // Allow proper flex behavior
      });

      // Ensure the input takes 70% of the width
      this.byId("chatInput").$().css({
        "width": "100%"
      });
    },
    onSend: async function () {
      const oModel = this.getView().getModel();
      const aMessages = oModel.getProperty("/messages");
      const sInput = this.byId("chatInput").getValue();

      if (!sInput) {
        MessageToast.show("Please enter a message.");
        return;
      }

      // Add user message
      aMessages.push({
        role: "User",
        text: sInput
      });
      oModel.setProperty("/messages", aMessages);

      // Clear input field
      this.byId("chatInput").setValue("");

      // Simulate bot response
      await this._getResponse(sInput);
    },

    _getResponse: async function (sInput) {
      const oModel = this.getView().getModel();
      const aMessages = oModel.getProperty("/messages");

      const sResponse = await this._getChatResponse(sInput);

      aMessages.push({
        role: "Bot",
        text: sResponse
      });
      oModel.setProperty("/messages", aMessages);

      // Scroll to the bottom of the chat
      this._scrollToBottom();
    },

    _getChatResponse: async function (sInput) {
      const sActionUrl = "/odata/v4/ticket-automator/TicketAutomatorService.sendQuestion"; // Full action URL
      const oPayload = {
        question: sInput // Payload for the action
      };

      return new Promise((resolve, reject) => {
        $.ajax({
          url: sActionUrl, // Action endpoint
          method: "POST", // HTTP method
          contentType: "application/json", // Specify JSON payload
          dataType: "json", // Expect JSON response
          data: JSON.stringify(oPayload), // Send the payload
          success: (oResponse) => {
            resolve(oResponse.value); // Resolve the promise with the response
          },
          error: (oError) => {
            console.error("Error invoking action:", oError);
            reject("An error occurred while processing your request."); // Reject the promise with an error message
          }
        });
      });
    },

    _scrollToBottom: function () {
      const oScrollContainer = this.byId("chatScroll");
      oScrollContainer.scrollTo(0, oScrollContainer.getDomRef().scrollHeight, 500);
    }
  });
});